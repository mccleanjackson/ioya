const {once} = require('node:events');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const {profileShare} = require('../profile-share');

// Profile → Share my profile: profile-share.js (/u/<code> and /api/u/<code>), public/profile.html,
// and the Share screen in public/app.html. Database side: supabase/profile-share.sql.
const publicDir = path.join(__dirname, '../public');
const AUTH = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.close(); server.closeAllConnections(); });
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('the public profile API returns only public details, and a QR code for real profiles', async t => {
  // A stand-in for Supabase's read_profile RPC.
  const asked = [];
  const fake = express();
  fake.use(express.json());
  fake.post('/rest/v1/rpc/read_profile', (req, res) => {
    asked.push({code: req.body.p_code, key: req.get('apikey')});
    if (req.body.p_code === 'k7m2qx9fpa') return res.json({first: 'Bea', last: 'Lee', avatar_path: `${AUTH}/abcdefgh12.jpg`,
      accounts: {venmo: 'bea-lee'}, preferred: 'venmo', phone: '8015550100'});
    if (req.body.p_code === 'badphoto22') return res.json({first: 'Al', last: '', avatar_path: '../../secret', accounts: null, preferred: 5});
    res.json(null);
  });
  let supabaseUrl;
  try { supabaseUrl = await listen(t, fake); }
  catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return t.skip('This environment blocks loopback HTTP.'); throw error; }

  const app = express();
  app.use(profileShare({preview: false, supabaseUrl, supabaseAnonKey: 'anon-test-key', publicDir, publicOrigin: 'https://ioya.example.com'}));
  const base = await listen(t, app);

  const r = await fetch(`${base}/api/u/k7m2qx9fpa`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), {first: 'Bea', last: 'Lee', avatarUrl: `${supabaseUrl}/storage/v1/object/public/avatars/${AUTH}/abcdefgh12.jpg`,
    accounts: {venmo: 'bea-lee'}, preferred: 'venmo'}, 'nothing extra (like a phone number) gets through');
  assert.equal(asked[0].key, 'anon-test-key');

  const odd = await (await fetch(`${base}/api/u/badphoto22`)).json();
  assert.equal(odd.avatarUrl, null, 'a strange photo path is dropped');
  assert.deepEqual(odd.accounts, {});
  assert.equal(odd.preferred, null);

  const gone = await fetch(`${base}/api/u/zzzzzzzzzz`);
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /isn't working/);

  const n = asked.length;
  for (const bad of ['K7M2QX9FPA', 'short', 'k7m2qx9fpa0', 'k7m2qx9fp1']) {
    assert.equal((await fetch(`${base}/api/u/${bad}`)).status, 404, bad);
  }
  assert.equal(asked.length, n, 'badly formed codes never reach the database');

  const qr = await fetch(`${base}/api/u/k7m2qx9fpa/qr`);
  assert.equal(qr.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await qr.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await fetch(`${base}/api/u/zzzzzzzzzz/qr`)).status, 404, 'no QR codes for profiles that don\'t exist');

  const page = await fetch(`${base}/u/k7m2qx9fpa`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), new RegExp(`img-src 'self' ${supabaseUrl.replace(/[.:/]/g, '\\$&')};`));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(await page.text(), /Ways to pay/);
});

test('without a public address, QR codes only work on this computer', async t => {
  const app = express();
  app.use(profileShare({preview: true, publicDir}));
  let base;
  try { base = await listen(t, app); }
  catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) return t.skip('This environment blocks loopback HTTP.'); throw error; }
  assert.equal((await fetch(`${base}/api/u/preview2ab/qr`)).headers.get('content-type'), 'image/png');
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/api/u/preview2ab/qr`, {headers: {Host: 'evil.example'}}, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 503, 'a made-up Host header can\'t put another site in the QR code');
});

// ---------- the public page (public/profile.html) ----------
function profilePage() {
  const html = fs.readFileSync(path.join(publicDir, 'profile.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const els = {};
  const el = id => els[id] ||= {id, hidden: false, textContent: '', children: [], className: '', append(...c) { this.children.push(...c); },
    setAttribute(k, v) { this[k] = v; }, focus() {}, select() {}};
  const document = {title: '', getElementById: el, createElement: tag => ({...el('x'), tag, children: []})};
  const context = {document, URLSearchParams, location: {pathname: '/u/k7m2qx9fpa'}, navigator: {}, fetch: () => new Promise(() => {}), console};
  vm.runInNewContext(script + ';globalThis.api={appInfo,show};', context);
  return {...context.api, els, document};
}

test('the public page opens payment apps or copies the account, and ignores anything odd', () => {
  const {appInfo} = profilePage();
  assert.equal(appInfo('venmo', 'bea-lee').href, 'https://venmo.com/?txn=pay&recipients=bea-lee');
  assert.equal(appInfo('paypal', 'BeaLee').href, 'https://www.paypal.me/BeaLee');
  assert.equal(appInfo('paypal', 'bea@example.com').copy, 'bea@example.com');
  assert.equal(appInfo('cashapp', '$BeaLee').href, 'https://cash.app/%24BeaLee');
  assert.deepEqual({...appInfo('zelle', '+18015550100')}, {account: '(801) 555-0100', copy: '+18015550100'});
  assert.equal(appInfo('applecash', '+18015550100').copy, '+18015550100');
  assert.equal(appInfo('applecash', 'bea@example.com'), null);
  assert.equal(appInfo('venmo', 'javascript:alert(1)'), null);
  assert.equal(appInfo('venmo', {}), null);
  assert.equal(appInfo('paypal', 'x/../../evil'), null);
});

test('the public page lists the preferred app first and shows names as text', () => {
  const {show, els, document} = profilePage();
  show({first: '<b>Bea</b>', last: 'Lee', avatarUrl: null, accounts: {venmo: 'bea-lee', zelle: '+18015550100', bogus: 'x'}, preferred: 'zelle'});
  assert.equal(els.name.textContent, '<b>Bea</b> Lee', 'set as text, never as HTML');
  assert.equal(document.title, '<b>Bea</b> Lee · IOYA');
  assert.equal(els.initials.textContent, '<L');
  const rows = els.apps.children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].className, /preferred/);
  assert.equal(rows[0].children[1].children[0].textContent, 'Zelle');
  assert.equal(rows[1].children[2].href, 'https://venmo.com/?txn=pay&recipients=bea-lee');
  assert.equal(els.profile.hidden, false);

  const empty = profilePage();
  empty.show({first: 'Al', last: '', avatarUrl: null, accounts: {}, preferred: null});
  assert.equal(empty.els.none.hidden, false);
  assert.match(empty.els.none.textContent, /Al hasn.t added any payment apps/);
});

// ---------- the Share screen in the app (public/app.html) ----------
const appHtml = fs.readFileSync(path.join(publicDir, 'app.html'), 'utf8');
const appScript = [...appHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function app({rpc} = {}) {
  const calls = [];
  const client = {auth: {getSession: async () => ({data: {session: {access_token: 't'}}})},
    rpc: async (name, args) => { calls.push(name); return rpc ? rpc(name, calls.length) : {data: 'k7m2qx9fpa', error: null}; },
    from: () => { throw new Error('not loaded in this test'); }};
  const window = {IOYA_CONFIG: {supabaseUrl: 'https://supabase.example.com', supabaseAnonKey: 'public-test-key'}, supabase: {createClient: () => client}};
  const el = {closest: () => el, setAttribute() {}, focus() {}, select() {}};
  const copied = [];
  const context = {window, location: {origin: 'https://ioya.example.com', search: '', pathname: '/app', hash: ''}, URLSearchParams,
    navigator: {userAgent: 'Android', clipboard: {writeText: async v => { copied.push(v); }}},
    document: {getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], addEventListener() {}},
    localStorage: {getItem: () => null, setItem() {}}, setTimeout: () => 0, clearTimeout() {}, console};
  vm.runInNewContext(appScript.replace('if (!V[S.view]', 'render=()=>{};globalThis.api={S,A,V,ui,profileState};return;\nif (!V[S.view]'), context);
  const api = context.api;
  Object.assign(api.S, {userId: 7, me: {first: 'Bea', last: 'Lee', phone: '', avatarUrl: null}, paymentAccounts: {}, history: [], contacts: [],
    account: {email: 'bea@example.com', guest: false, since: null}});
  return {...api, calls, copied};
}

test('saved profiles see Share my profile; guests are told to create a profile', () => {
  const api = app();
  assert.match(api.V.profile(), /data-act="pstep" data-step="share"[^>]*>.*Share my profile/);
  api.S.account = {email: null, guest: true, since: null};
  const guest = api.V.profile();
  assert.doesNotMatch(guest, /data-step="share"/);
  assert.match(guest, /share your profile with a QR code/);
});

test('Share my profile shows the QR code and link; Make a new link asks first', async () => {
  const codes = ['k7m2qx9fpa', 'n3w4c5d6e7'];
  const api = app({rpc: (name, i) => ({data: codes[i - 1], error: null})});
  api.A.pstep({step: 'share'}); await tick();
  assert.deepEqual(api.calls, ['get_my_profile_code']);
  let html = api.V.profile();
  assert.match(html, /<img class="qr" src="\/api\/u\/k7m2qx9fpa\/qr"/);
  assert.match(html, /value="https:\/\/ioya.example.com\/u\/k7m2qx9fpa"/);
  assert.match(html, /phone number, email, contacts and splits stay private/);

  await api.A.copyProfileLink();
  assert.deepEqual(api.copied, ['https://ioya.example.com/u/k7m2qx9fpa']);

  api.A.newProfileCode({});
  html = api.V.profile();
  assert.match(html, /stop working right away/);
  assert.equal(api.calls.length, 1, 'nothing changes until confirmed');
  api.A.newProfileCode({cancel: '1'});
  assert.doesNotMatch(api.V.profile(), /stop working right away/);

  api.A.newProfileCode({}); api.A.newProfileCode({confirm: '1'}); await tick();
  assert.deepEqual(api.calls, ['get_my_profile_code', 'new_my_profile_code']);
  assert.match(api.V.profile(), /\/api\/u\/n3w4c5d6e7\/qr/);
  assert.match(api.ui.toast, /old link and QR code no longer work/);

  api.A.pstep({});
  assert.doesNotMatch(api.V.profile(), /api\/u\//, 'Back returns to the profile');
});

test('Share my profile explains what to do when the SQL hasn\'t been run', async () => {
  const api = app({rpc: () => ({data: null, error: {message: 'Could not find the function public.get_my_profile_code without parameters in the schema cache'}})});
  api.A.pstep({step: 'share'}); await tick();
  const html = api.V.profile();
  assert.match(html, /Run supabase\/profile-share.sql/);
  assert.match(html, /data-step="share"[^>]*>Try again/);
});
