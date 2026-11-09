const {createHmac, randomUUID, timingSafeEqual} = require('node:crypto');

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const usPhone = /^\+1[2-9][0-9]{9}$/;
const messageSid = /^SM[0-9a-f]{32}$/i;
const acceptedStatuses = new Set(['accepted', 'queued', 'sending', 'sent', 'delivered']);

function readSmsConfig(env) {
  const account = env.TWILIO_ACCOUNT_SID;
  const key = env.TWILIO_API_KEY_SID;
  const secret = env.TWILIO_API_KEY_SECRET;
  const service = env.TWILIO_MESSAGING_SERVICE_SID;
  const allowed = (env.IOYA_SMS_ALLOWED_USERS || '').split(',').map(id => id.trim().toLowerCase()).filter(Boolean);
  if (!/^AC[0-9a-f]{32}$/i.test(account || '') || !/^SK[0-9a-f]{32}$/i.test(key || '') ||
      !secret || !/^MG[0-9a-f]{32}$/i.test(service || '') || !allowed.length || allowed.some(id => !uuid.test(id))) return null;
  return {account, key, secret, service, allowed: new Set(allowed)};
}

function failure(status, message) {
  return Object.assign(new Error(message), {status});
}

function proof(config, id, phone, sid) {
  // Clients can call the owner-only database RPCs directly. Only the server can attest a Twilio response.
  return createHmac('sha256', config.secret).update(JSON.stringify(['ioya-sms-v1', id, phone, sid])).digest('hex');
}

function wasSubmitted(config, id, phone, record) {
  return messageSid.test(record.sid || '') && /^[0-9a-f]{64}$/.test(record.proof || '') &&
    timingSafeEqual(Buffer.from(record.proof, 'hex'), Buffer.from(proof(config, id, phone, record.sid), 'hex'));
}

function createSmsDelivery({config, supabaseUrl, supabaseAnonKey, query, fetcher = fetch}) {
  return async ({id, token, phone, url}) => {
    if (!config) throw failure(503, 'Automatic texts are unavailable.');
    if (typeof phone !== 'string' || !usPhone.test(phone)) throw failure(400, 'Enter a valid U.S. mobile number.');
    const userResponse = await fetcher(new URL('/auth/v1/user', supabaseUrl), {
      headers: {apikey: supabaseAnonKey, Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    if (!userResponse.ok) throw failure(403, 'This account cannot send automatic texts.');
    const user = await userResponse.json();
    if (user.is_anonymous === true || !config.allowed.has(user.id)) {
      throw failure(403, 'This account cannot send automatic texts.');
    }

    const attempt = randomUUID();
    const reservation = await query('reserve_manual_payment_sms', {p_id: id, p_phone: phone, p_attempt: attempt}, token);
    if (reservation.status !== 'reserved') {
      if (reservation.phone !== phone) throw failure(409, 'This link has already been used for a different phone number.');
      if (reservation.status === 'submitted' && wasSubmitted(config, id, phone, reservation)) return {status: 'submitted'};
      if (reservation.status === 'rejected') throw failure(502, 'The text provider rejected this request.');
      throw failure(409, 'The previous text submission could not be confirmed. Check the messaging dashboard before resending.');
    }

    const payer = String(reservation.payeeName || 'Your friend').replace(/\s+/g, ' ').trim();
    const body = new URLSearchParams({To: phone, MessagingServiceSid: config.service,
      Body: `${payer} has split the bill with you. Pay your part: ${url}`});
    const auth = Buffer.from(`${config.key}:${config.secret}`).toString('base64');
    let response, result;
    try {
      response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages.json`, {
        method: 'POST', headers: {Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded'},
        body, signal: AbortSignal.timeout(10000), redirect: 'error'
      });
      result = await response.json();
    } catch {
      throw failure(409, 'Text submission could not be confirmed. Check the messaging dashboard before resending.');
    }
    if (response.ok && messageSid.test(result?.sid || '') && acceptedStatuses.has(result.status)) {
      try {
        await query('finish_manual_payment_sms', {
          p_id: id, p_attempt: attempt, p_sid: result.sid, p_proof: proof(config, id, phone, result.sid)
        }, token);
      } catch { /* Twilio accepted the message. The durable reservation still prevents a duplicate send. */ }
      return {status: 'submitted'};
    }
    if (response.status >= 400 && response.status < 500) {
      try { await query('finish_manual_payment_sms', {p_id: id, p_attempt: attempt, p_sid: null, p_proof: null}, token); }
      catch { /* Keep the reservation when the provider result cannot be saved. */ }
      throw failure(502, 'The text provider rejected this request.');
    }
    throw failure(409, 'Text submission could not be confirmed. Check the messaging dashboard before resending.');
  };
}

module.exports = {readSmsConfig, createSmsDelivery};
