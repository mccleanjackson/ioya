const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSmsDelivery, readSmsConfig} = require('../sms-delivery');

const id = '10000000-0000-4000-8000-000000000001';
const user = '10000000-0000-4000-8000-000000000002';
const sid = 'SM' + 'a'.repeat(32);
const config = readSmsConfig({
  TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
  TWILIO_API_KEY_SID: 'SK' + 'a'.repeat(32),
  TWILIO_API_KEY_SECRET: 'test-only-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MG' + 'a'.repeat(32),
  IOYA_SMS_ALLOWED_USERS: user
});
const request = {id, token: 'example-auth-token', phone: '+18015550102', url: `https://ioya.example/pay#${id}`};

function fixture(options = {}) {
  let ledger = options.ledger;
  const sends = [];
  const query = async (rpc, args, token) => {
    assert.equal(token, request.token);
    assert.equal(args.p_id, request.id);
    if (rpc === 'reserve_manual_payment_sms') {
      if (ledger) return ledger;
      ledger = {status: 'pending', phone: args.p_phone, attempt: args.p_attempt};
      return {status: 'reserved', payeeName: 'Taylor Rivera'};
    }
    assert.equal(rpc, 'finish_manual_payment_sms');
    assert.equal(args.p_attempt, ledger.attempt);
    Object.assign(ledger, {status: args.p_sid ? 'submitted' : 'rejected', sid: args.p_sid, proof: args.p_proof});
    return true;
  };
  const fetcher = async (url, init) => {
    if (String(url) === 'https://database.example/auth/v1/user') {
      assert.equal(init.headers.Authorization, `Bearer ${request.token}`);
      return {ok: true, json: async () => ({id: options.user || user, is_anonymous: options.guest || false})};
    }
    assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages.json`);
    sends.push(init);
    if (options.timeout) throw new Error('provider timeout');
    if (options.reject) return {ok: false, status: 400, json: async () => ({})};
    return {ok: true, json: async () => ({sid, status: 'accepted'})};
  };
  const send = createSmsDelivery({config, supabaseUrl: 'https://database.example', supabaseAnonKey: 'public-key', query, fetcher});
  return {send, sends};
}

test('authorized SMS submits the preset payer message and canonical link only once', async () => {
  const {send, sends} = fixture();
  assert.deepEqual(await send(request), {status: 'submitted'});
  assert.deepEqual(await send(request), {status: 'submitted'});
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.get('To'), request.phone);
  assert.equal(sends[0].body.get('MessagingServiceSid'), config.service);
  assert.equal(sends[0].body.get('Body'), 'Taylor Rivera has split the bill with you. Pay your part: ' + request.url);
  await assert.rejects(send({...request, phone: '+18015550103'}), {status: 409});
});

test('unverified senders, missing configuration and invalid numbers never reach the provider', async () => {
  assert.equal(readSmsConfig({}), null);
  const disabled = createSmsDelivery({config: null});
  await assert.rejects(disabled(request), {status: 503});
  for (const options of [{user: id}, {guest: true}]) {
    const {send, sends} = fixture(options);
    await assert.rejects(send(request), {status: 403});
    await assert.rejects(send({...request, phone: '555'}), {status: 400});
    assert.equal(sends.length, 0);
  }
});

test('ambiguous provider timeouts and rejected messages never get an automatic second attempt', async () => {
  for (const [options, status] of [[{timeout: true}, 409], [{reject: true}, 502]]) {
    const {send, sends} = fixture(options);
    await assert.rejects(send(request), {status});
    await assert.rejects(send(request), {status});
    assert.equal(sends.length, 1);
  }
  const forged = fixture({ledger: {status: 'submitted', phone: request.phone, sid, proof: 'a'.repeat(64)}});
  await assert.rejects(forged.send(request), {status: 409});
  assert.equal(forged.sends.length, 0);
});
