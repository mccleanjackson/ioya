const {once} = require('node:events');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {manualPaymentRequests} = require('../manual-payment-requests');

test('manual requests keep private data out of the public page and QR', async t => {
  const app = express();
  app.use('/api/manual-requests', manualPaymentRequests({preview: true}));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/api/manual-requests`;
  const owner = {Authorization: 'Bearer preview'};
  const data = {amountCents: 1234, note: 'Lunch', payeeName: 'Test Payer', methods: {venmo: 'Test-Payer'}};
  const post = (url, body, headers = {}) => fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body)
  });

  const anonymous = await post(base, {contactId: 42, ...data}).catch(error => {
    if (error.cause?.code !== 'EACCES' && error.cause?.code !== 'EPERM') throw error;
    t.skip('This environment blocks loopback HTTP.');
  });
  if (!anonymous) return;
  assert.equal(anonymous.status, 401);
  assert.equal((await post(base, {
    contactId: 42, ...data, methods: {applePayUrl: 'https://buy.stripe.com.evil.example/x'}
  }, owner)).status, 400);
  const options = {paypal: 'payer@example.com', cashapp: '$Payer2026', applecash: '(801) 555-0102'};
  const optionsLink = await post(base, {contactId: 44, ...data, methods: options}, owner);
  assert.equal(optionsLink.status, 201);
  const optionsId = (await optionsLink.json()).id;
  const optionsRecipient = await (await fetch(base + '/' + optionsId)).json();
  assert.deepEqual(optionsRecipient.methods, {...options, applecash: '+18015550102'});
  for (const [method, account] of Object.entries({cashapp: '$123', applecash: 'payer@example.com'})) {
    assert.equal((await post(base, {contactId: 44, ...data, methods: {[method]: account}}, owner)).status, 400);
  }
  for (const method of ['cashapp', 'applecash']) {
    assert.equal((await post(base + '/' + optionsId + '/consent', {method, username: options[method]})).status, 400);
  }
  const created = await post(base, {contactId: 42, ...data}, owner);
  assert.equal(created.status, 201);
  const {id, url} = await created.json();
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(url, `${origin}/pay#${id}`);

  const link = `${base}/${id}`;
  const recipient = await fetch(link);
  assert.equal(recipient.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await recipient.json(), data);
  const qr = await fetch(`${link}/qr`);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await qr.arrayBuffer());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const consentUrl = `${link}/consent`;
  assert.equal((await fetch(consentUrl)).status, 401);
  assert.equal((await post(`${consentUrl}/save`, {}, owner)).status, 400);
  assert.deepEqual(await (await fetch(consentUrl, {headers: owner})).json(), {consent: null});
  assert.equal((await post(consentUrl, {method: 'applePayUrl', username: 'https://buy.stripe.com/x'})).status, 400);
  const consent = {method: 'venmo', username: 'Test-Friend'};
  assert.deepEqual(await (await post(consentUrl, consent)).json(), {ok: true});
  assert.equal((await post(consentUrl, {...consent, username: 'Another-Friend'})).status, 409);
  assert.deepEqual(await (await fetch(consentUrl, {headers: owner})).json(), {consent});
  assert.equal((await post(`${consentUrl}/save`, {})).status, 401);
  assert.deepEqual(await (await post(`${consentUrl}/save`, {}, owner)).json(), {ok: true});
  assert.deepEqual(await (await fetch(link)).json(), data);
  assert.equal((await post(`${link}/sms`, {phone: '+18015550102'})).status, 401);
  assert.equal((await post(`${link}/sms`, {phone: '+18015550102'}, owner)).status, 503);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);

  const items = [
    {name: 'Sandwich', amountCents: 1200, privateId: 33},
    {name: 'Tax and tip', amountCents: 34}
  ];
  assert.equal((await post(base, {contactId: 43, ...data, items: items.slice(0, 1)}, owner)).status, 400);
  const second = await post(base, {contactId: 43, ...data, items}, owner);
  assert.equal(second.status, 201);
  const secondId = (await second.json()).id;
  assert.deepEqual((await (await fetch(`${base}/${secondId}`)).json()).items, [
    {name: 'Sandwich', amountCents: 1200},
    {name: 'Tax and tip', amountCents: 34}
  ]);

  const groupRoute = `${base}/group`;
  const recipients = [{id, name: 'First Friend'}, {id: secondId, name: 'Second Friend'}];
  assert.equal((await post(groupRoute, {recipients})).status, 401);
  assert.equal((await post(groupRoute, {recipients: [recipients[0], recipients[0]]}, owner)).status, 400);
  assert.equal((await post(groupRoute, {
    recipients: [{id: '00000000-0000-0000-0000-000000000000', name: 'Missing'}]
  }, owner)).status, 404);
  const duplicateContact = await post(base, {contactId: 42, ...data}, owner);
  assert.equal((await post(groupRoute, {
    recipients: [recipients[0], {id: (await duplicateContact.json()).id, name: 'Also First Friend'}]
  }, owner)).status, 400);

  const createdGroup = await post(groupRoute, {recipients}, owner);
  assert.equal(createdGroup.status, 201);
  const group = await createdGroup.json();
  assert.equal(group.url, `${origin}/pay#group=${group.id}`);
  assert.deepEqual(await (await post(groupRoute, {recipients}, owner)).json(), group);
  const groupPage = await fetch(`${groupRoute}/${group.id}`);
  assert.equal(groupPage.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await groupPage.json(), {recipients});
  const groupQr = await fetch(`${groupRoute}/${group.id}/qr`);
  assert.equal(groupQr.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await groupQr.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
