const {randomUUID} = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const {createSmsDelivery} = require('./sms-delivery');

const requestIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const venmoPattern = /^[A-Za-z0-9_-]{5,30}$/;
const paypalPattern = /^[A-Za-z0-9]{1,20}$/;
const cashTagPattern = /^\$(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,20}$/;
const phonePattern = /^\+1[2-9][0-9]{9}$/;
const checkoutPattern = /^https:\/\/(?:buy|checkout)\.stripe\.com\/[A-Za-z0-9_/-]+(?:#[A-Za-z0-9%=_-]+)?$/;

function failure(status, message) {
  return Object.assign(new Error(message), {status});
}

function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw failure(400, 'Enter valid payment request details.');
  }
  return value.trim();
}

function accountValue(method, value, consent = false) {
  const input = text(value, method === 'applePayUrl' ? 1000 : 100);
  if (method === 'venmo' && venmoPattern.test(input.replace(/^@/, ''))) return input.replace(/^@/, '');
  if (method === 'paypal' && paypalPattern.test(input)) return input;
  const cashApp = method === 'cashapp' && !consent;
  if (cashApp && cashTagPattern.test(input)) return input;
  if ((['paypal', 'zelle'].includes(method) || cashApp) && emailPattern.test(input)) return input;
  if ((method === 'zelle' || cashApp || (method === 'applecash' && !consent)) && /^\+?[0-9(). -]+$/.test(input)) {
    const digits = input.replace(/\D/g, '');
    const phone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (phonePattern.test(phone)) return phone;
  }
  if (method === 'applePayUrl' && !consent && checkoutPattern.test(input)) return input;
  throw failure(400, 'Check the payment account or checkout link.');
}

function requestDetails(body) {
  const {contactId, amountCents, note, payeeName, methods, items} = body || {};
  if (!Number.isInteger(contactId) || contactId < 1 || contactId > 2147483647
      || !Number.isInteger(amountCents) || amountCents < 1 || amountCents > 1000000
      || !methods || typeof methods !== 'object' || Array.isArray(methods)
      || !Object.keys(methods).length) {
    throw failure(400, 'Enter an amount and at least one way to pay.');
  }
  const normalized = Object.fromEntries(Object.entries(methods).map(([method, value]) => [method, accountValue(method, value)]));
  const payer = text(payeeName, 80);
  const message = note == null ? `${payer} has split the bill with you. Pay your part.` : text(note, 160);
  const data = {amountCents, note: message, payeeName: payer, methods: normalized};
  if (items !== undefined) {
    if (!Array.isArray(items) || !items.length || items.length > 100 || items.some(item =>
      !Number.isInteger(item?.amountCents) || item.amountCents < 0 || item.amountCents > amountCents
    ) || items.reduce((sum, item) => sum + item.amountCents, 0) !== amountCents) {
      throw failure(400, 'The item breakdown must add up to the requested amount.');
    }
    data.items = items.map(item => ({name: text(item.name, 120), amountCents: item.amountCents}));
  }
  return {contactId, data};
}

function groupRecipients(body) {
  const {recipients} = body || {};
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > 11 || recipients.some(
    recipient => typeof recipient?.id !== 'string' || !requestIdPattern.test(recipient.id)
  ) || new Set(recipients.map(recipient => recipient.id)).size !== recipients.length) {
    throw failure(400, 'Choose distinct payment links for up to 11 contacts.');
  }
  return recipients.map(recipient => ({id: recipient.id, name: text(recipient.name, 80)}));
}

function requestConsent(body) {
  const {method, username} = body || {};
  return {method, username: accountValue(method, username, true)};
}

function previewStore() {
  const links = new Map();
  const groups = new Map();
  return async (rpc, args) => {
    const now = Date.now();
    if (rpc === 'create_manual_payment_request') {
      for (const [id, link] of links) if (link.expiresAt <= now) links.delete(id);
      if (links.size >= 100) throw failure(429, 'Too many active payment links.');
      const id = randomUUID();
      links.set(id, {data: args.p_data, contactId: args.p_contact_id, consent: null, expiresAt: now + 7 * 86400000});
      return id;
    }
    if (rpc === 'create_manual_payment_group') {
      const recipients = args.p_recipients;
      const members = recipients.map(recipient => links.get(recipient.id));
      if (members.some(link => !link || link.expiresAt <= now)) {
        throw failure(404, 'A payment request is unavailable or has expired.');
      }
      if (new Set(members.map(link => link.contactId)).size !== members.length) {
        throw failure(400, 'Select each contact only once.');
      }
      for (const [id, group] of groups) {
        if (group.expiresAt <= now) groups.delete(id);
        else if (JSON.stringify(group.recipients) === JSON.stringify(recipients)) return id;
      }
      if (groups.size >= 100) throw failure(429, 'Too many active payment links.');
      const id = randomUUID();
      groups.set(id, {recipients, expiresAt: Math.min(...members.map(link => link.expiresAt))});
      return id;
    }
    if (rpc === 'read_manual_payment_group') {
      const group = groups.get(args.p_id);
      if (!group || group.expiresAt <= now) throw failure(404, 'This payment request is unavailable or has expired.');
      return {recipients: group.recipients};
    }
    const link = links.get(args.p_id);
    if (!link || link.expiresAt <= now) throw failure(404, 'This payment request is unavailable or has expired.');
    if (rpc === 'read_manual_payment_request') return link.data;
    if (rpc === 'read_manual_payment_consent') return link.consent;
    if (rpc === 'save_manual_payment_consent') {
      if (!link.consent) throw failure(400, 'This contact has not shared an account.');
      return true;
    }
    if (link.consent && (link.consent.method !== args.p_consent.method || link.consent.username !== args.p_consent.username)) {
      throw failure(409, 'Payment details have already been shared for this link.');
    }
    link.consent = args.p_consent;
    return true;
  };
}

function supabaseStore({supabaseUrl, supabaseAnonKey}) {
  return async (rpc, args, token) => {
    const headers = {apikey: supabaseAnonKey, 'Content-Type': 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(new URL(`/rest/v1/rpc/${rpc}`, supabaseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (response.ok) return result;
    if (rpc === 'save_manual_payment_consent' && result?.code === '23505') {
      throw failure(409, 'This contact already has a different account for that payment method.');
    }
    if (rpc === 'save_manual_payment_consent' && result?.code === '22023') {
      throw failure(400, 'No supported account has been shared for this link.');
    }
    if (result?.code === 'P0002') throw failure(404, 'This payment request is unavailable or has expired.');
    if (result?.code === '23505') throw failure(409, 'Payment details have already been shared for this link.');
    if (result?.code === '54000') throw failure(429, rpc === 'reserve_manual_payment_sms' ? 'Daily text limit reached.' : 'Too many active payment links.');
    if (result?.code === '22023') throw failure(400, 'Enter valid payment request details.');
    if (response.status === 401 || response.status === 403) throw failure(response.status, 'Sign in and select one of your contacts.');
    throw failure(503, 'Payment links are unavailable. Try again later.');
  };
}

function manualPaymentRequests({preview, supabaseUrl, supabaseAnonKey, publicOrigin, sms}) {
  const router = express.Router();
  const query = preview ? previewStore() : supabaseStore({supabaseUrl, supabaseAnonKey});
  const sendSms = createSmsDelivery({config: preview ? null : sms, supabaseUrl, supabaseAnonKey, query});
  function owner(req) {
    const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1];
    if (!token || (preview && token !== 'preview')) throw failure(401, 'Sign in to manage payment links.');
    return token;
  }
  function recipientUrl(req, id, group = false) {
    const origin = preview ? `http://127.0.0.1:${req.socket.localPort}` : publicOrigin;
    if (!origin) throw failure(503, 'Set IOYA_PUBLIC_ORIGIN to enable payment links.');
    const url = new URL('/pay', origin);
    url.hash = group ? 'group=' + id : id;
    return url.href;
  }
  router.use((req, res, next) => {
    res.set({'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'});
    next();
  }, express.json({limit: '64kb'}));
  router.param('id', (req, res, next, id) => {
    next(requestIdPattern.test(id) ? undefined : failure(404, 'This payment request is unavailable or has expired.'));
  });
  router.post('/', async (req, res) => {
    const token = owner(req);
    const {contactId, data} = requestDetails(req.body);
    recipientUrl(req, '');
    const id = await query('create_manual_payment_request', {p_contact_id: contactId, p_data: data}, token);
    res.status(201).json({id, url: recipientUrl(req, id)});
  });
  router.post('/group', async (req, res) => {
    const token = owner(req);
    const recipients = groupRecipients(req.body);
    recipientUrl(req, '');
    const id = await query('create_manual_payment_group', {p_recipients: recipients}, token);
    res.status(201).json({id, url: recipientUrl(req, id, true)});
  });
  router.get('/group/:id', async (req, res) => {
    res.json(await query('read_manual_payment_group', {p_id: req.params.id}));
  });
  router.get('/group/:id/qr', async (req, res) => {
    const id = req.params.id;
    const url = recipientUrl(req, id, true);
    await query('read_manual_payment_group', {p_id: id});
    res.type('png').send(await QRCode.toBuffer(url, {width: 320, margin: 4}));
  });
  router.get('/:id', async (req, res) => {
    res.json(await query('read_manual_payment_request', {p_id: req.params.id}));
  });
  router.get('/:id/qr', async (req, res) => {
    const id = req.params.id;
    const url = recipientUrl(req, id);
    await query('read_manual_payment_request', {p_id: id});
    res.type('png').send(await QRCode.toBuffer(url, {width: 320, margin: 4}));
  });
  router.post('/:id/sms', async (req, res) => {
    const id = req.params.id;
    const token = owner(req);
    res.json(await sendSms({id, token, phone: req.body?.phone, url: recipientUrl(req, id)}));
  });
  router.post('/:id/consent', async (req, res) => {
    await query('record_manual_payment_consent', {p_id: req.params.id, p_consent: requestConsent(req.body)});
    res.json({ok: true});
  });
  router.get('/:id/consent', async (req, res) => {
    const consent = await query('read_manual_payment_consent', {p_id: req.params.id}, owner(req));
    res.json({consent});
  });
  router.post('/:id/consent/save', async (req, res) => {
    await query('save_manual_payment_consent', {p_id: req.params.id}, owner(req));
    res.json({ok: true});
  });
  router.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({error: 'Enter valid payment request details.'});
    if (error.type === 'entity.too.large') return res.status(413).json({error: 'Payment request details are too long.'});
    res.status(error.status || 503).json({error: error.status ? error.message : 'Payment links are unavailable. Try again later.'});
  });
  return router;
}

module.exports = {manualPaymentRequests};
