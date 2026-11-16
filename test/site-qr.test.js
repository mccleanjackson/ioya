const {once} = require('node:events');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const {siteQr} = require('../site-qr');

// The landing page's "Scan to open IOYA" QR code (/qr.png, site-qr.js).
async function serve(t, options) {
  const app = express(); app.use(siteQr(options));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.close(); server.closeAllConnections(); });
  try { await once(server, 'listening'); } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return null; throw error; }
  return `http://127.0.0.1:${server.address().port}`;
}
const get = (url, host) => new Promise((resolve, reject) => {
  http.get(url, host ? {headers: {Host: host}} : {}, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks)})); }).on('error', reject);
});

test('the QR code is a PNG for the public address, or for localhost when running locally', async t => {
  const live = await serve(t, {publicOrigin: 'https://ioya.example.com'});
  if (!live) return t.skip('This environment blocks loopback HTTP.');
  const png = await get(`${live}/qr.png`);
  assert.equal(png.status, 200);
  assert.equal(png.type, 'image/png');
  assert.equal(png.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const local = await serve(t, {publicOrigin: null});
  assert.equal((await get(`${local}/qr.png`)).status, 200, 'localhost works without a public address');
  assert.equal((await get(`${local}/qr.png`, 'evil.example')).status, 404, "a made-up Host can't put another site in the code");
});

test('the landing page shows the QR card on laptops only, and hides it if the code fails', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<div class="qr-card" id="qr-card">\s*<img id="qr-img" src="\/qr.png"[^>]*alt="QR code that opens IOYA's home page">/);
  assert.match(html, /Scan to open IOYA on your phone/);
  assert.match(html, /@media \(max-width:900px\)\{\.qr-card\{display:none\}\}/);
  assert.match(html, /\.qr-card\[hidden\]\{display:none\}/);
  assert.match(html, /img\.addEventListener\('error', \(\) => \{ card\.hidden = true; \}\)/);
});
