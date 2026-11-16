const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Discard split (public/app.html): throws away the unfinished split kept in this browser.
const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

function app() {
  const stored = {};
  const client = {auth: {getSession: async () => ({data: {session: {access_token: 't'}}})},
    rpc: async () => ({data: null, error: null}), from: () => { throw new Error('not loaded in this test'); }};
  const window = {IOYA_CONFIG: {supabaseUrl: 'https://supabase.example.com', supabaseAnonKey: 'public-test-key'}, supabase: {createClient: () => client}};
  const el = {closest: () => el, setAttribute() {}, focus() {}, select() {}};
  const context = {window, location: {origin: 'https://ioya.example.com', search: '', pathname: '/app', hash: ''}, URLSearchParams,
    navigator: {userAgent: 'Android', clipboard: {writeText: async () => {}}},
    document: {getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], addEventListener() {}},
    localStorage: {getItem: k => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }}, setTimeout: () => 0, clearTimeout() {}, console};
  // render() normally draws the page and saves the draft; here it only saves, like the real one does last.
  vm.runInNewContext(script.replace('if (!V[S.view]', 'render=()=>{save();};globalThis.api={S,A,V,ui,newDraft};return;\nif (!V[S.view]'), context);
  const api = context.api;
  Object.assign(api.S, {userId: 7, selfContactId: '1', contacts: [], history: [], paymentAccounts: {}});
  return {...api, stored};
}
function startSplit(api, at = 'assign') {
  const d = api.newDraft();
  Object.assign(d, {merchant: 'Sakura Ramen', items: [{id: 'a', name: 'Ramen', price: 1500}], at});
  api.S.draft = d; api.S.view = at;
  return d;
}

test('Home shows Discard next to Resume current split, only when there is a split', () => {
  const api = app();
  api.S.view = 'home';
  assert.doesNotMatch(api.V.home(), /askDiscard/);
  startSplit(api);
  assert.match(api.V.home(), /data-act="resume"[\s\S]*data-act="askDiscard">Discard</);
});

test('every split screen and the camera banner offer Discard', () => {
  const api = app();
  startSplit(api);
  for (const view of ['review', 'assign', 'summary']) assert.match(api.V[view](), /data-act="askDiscard"[^>]*>.*Discard split/, view);
  assert.match(api.V.scan(), /Resume split<\/button>\s*<button class="btn small ghost" data-act="askDiscard">Discard/);
});

test('Discard asks first; Keep split leaves everything as it was', () => {
  const api = app();
  const d = startSplit(api);
  api.A.askDiscard();
  assert.equal(api.ui.sheet.type, 'discardSplit');
  api.A.close();  // Keep split
  assert.equal(api.ui.sheet, null);
  assert.equal(api.S.draft, d);
  assert.equal(api.S.draft.items.length, 1);
});

test('Discard split clears the split, goes Home, and stays gone after a refresh', () => {
  const api = app();
  startSplit(api, 'summary');
  api.A.askDiscard();
  api.A.discardSplit();
  assert.equal(api.ui.sheet, null);
  assert.equal(api.S.view, 'home');
  assert.equal(api.S.draft.items.length, 0);
  assert.equal(api.S.draft.merchant, '');
  assert.equal(api.ui.toast, 'Split discarded.');
  assert.doesNotMatch(api.V.home(), /Resume current split/);
  const saved = JSON.parse(api.stored['ioya-draft-v1']);
  assert.equal(saved.draft.items.length, 0, 'the browser copy is cleared too, so a refresh has nothing to resume');
});

test('Discard is blocked while the split is being saved to History', () => {
  const api = app();
  const d = startSplit(api, 'sent');
  api.ui.savingSplit = true;
  api.A.askDiscard();
  assert.equal(api.ui.sheet ?? null, null);
  api.A.discardSplit();
  assert.equal(api.S.draft, d);
});
