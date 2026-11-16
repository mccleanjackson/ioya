const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reordering groups on the Contacts tab (public/app.html → save_group_order() in supabase/group-order.sql).
const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function app({rpc, tables = {}} = {}) {
  const calls = [], listeners = {};
  const query = rows => { const o = {select: () => o, eq: () => o, order: () => o, single: () => Promise.resolve({data: rows[0], error: null}),
    then: (f, g) => Promise.resolve({data: rows, error: null}).then(f, g)}; return o; };
  const client = {auth: {getSession: async () => ({data: {session: {access_token: 't', user: {id: 'u', is_anonymous: false, email: 'a@b.c'}}}})},
    rpc: async (name, args) => { calls.push([name, JSON.parse(JSON.stringify(args ?? null))]); return rpc ? rpc(name, args) : {data: 7, error: null}; },
    from: t => query(tables[t] || [])};
  const window = {IOYA_CONFIG: {supabaseUrl: 'https://supabase.example.com', supabaseAnonKey: 'public-test-key'}, supabase: {createClient: () => client}};
  const el = {closest: () => null, setAttribute() {}, focus() {}, select() {}};
  const context = {window, location: {origin: 'https://ioya.example.com', search: '', pathname: '/app', hash: ''}, URLSearchParams, CSS: {escape: s => s},
    navigator: {userAgent: 'Android', clipboard: {writeText: async () => {}}},
    document: {getElementById: () => el, querySelector: () => el, querySelectorAll: () => [], addEventListener: (t, f) => (listeners[t] ||= []).push(f)},
    localStorage: {getItem: () => null, setItem() {}}, setTimeout: () => 0, clearTimeout() {}, console};
  vm.runInNewContext(script.replace('if (!V[S.view]', 'render=()=>{};globalThis.api={S,A,V,ui,moveGroup,pickerResults,loadAll};return;\nif (!V[S.view]'), context);
  const api = context.api;
  return {...api, calls, listeners};
}
const groups = () => [{id: '3', name: 'Family', members: ['10']}, {id: '5', name: 'Lunch crew', members: ['10']}, {id: '9', name: 'Roommates', members: ['10']}];

test('Contacts shows groups in the saved order with a reorder hint; colors stay with each group', () => {
  const api = app();
  Object.assign(api.S, {userId: 1, contacts: [{id: '10', name: 'Alex', first: 'Alex', last: '', methods: []}], groups: groups()});
  const html = api.V.contacts();
  assert.ok(html.indexOf('Family') < html.indexOf('Lunch crew') && html.indexOf('Lunch crew') < html.indexOf('Roommates'));
  assert.match(html, /id="group-order-hint">Drag a group to reorder/);
  assert.match(html, /data-id="3" data-tone="0"/);
  assert.match(html, /data-id="5" data-tone="2"/);
  api.S.groups = [groups()[0]];
  assert.doesNotMatch(api.V.contacts(), /group-order-hint/, 'no hint with only one group');
});

test('moving a group reorders it right away and saves the whole order', async () => {
  const api = app();
  Object.assign(api.S, {userId: 1, groups: groups()});
  assert.equal(api.moveGroup('9', 0), true);
  assert.deepEqual(api.S.groups.map(g => g.name), ['Roommates', 'Family', 'Lunch crew']);
  await tick();
  assert.deepEqual(api.calls, [['save_group_order', {p_group_ids: [9, 3, 5]}]]);
  assert.equal(api.moveGroup('9', 0), false, 'same place: nothing to save');
  assert.equal(api.moveGroup('9', 7), false, 'out of range');
  assert.equal(api.calls.length, 1);
});

test('if saving fails, the old order comes back and the message says why', async () => {
  for (const [message, expected] of [['Could not find the function public.save_group_order(p_group_ids)', /run supabase\/group-order.sql/],
                                     ['Failed to fetch', /Couldn't save the new group order/]]) {
    const api = app({rpc: () => ({data: null, error: {message}})});
    Object.assign(api.S, {userId: 1, groups: groups()});
    api.moveGroup('3', 2);
    assert.deepEqual(api.S.groups.map(g => g.name), ['Lunch crew', 'Roommates', 'Family']);
    await tick();
    assert.deepEqual(api.S.groups.map(g => g.name), ['Family', 'Lunch crew', 'Roommates']);
    assert.match(api.ui.toast, expected);
  }
});

test('Alt + arrow keys move the focused group', async () => {
  const api = app();
  Object.assign(api.S, {userId: 1, groups: groups()});
  const button = {dataset: {id: '3'}};
  const key = k => api.listeners.keydown.forEach(f => f({key: k, altKey: true, target: {closest: s => s.includes('#group-row .grp') ? button : null}, preventDefault() {}}));
  key('ArrowRight');
  assert.deepEqual(api.S.groups.map(g => g.name), ['Lunch crew', 'Family', 'Roommates']);
  assert.equal(api.ui.toast, 'Moved Family to position 2 of 3.');
  key('ArrowLeft'); key('ArrowLeft');
  assert.deepEqual(api.S.groups.map(g => g.name), ['Family', 'Lunch crew', 'Roommates'], 'stops at the start');
});

test('groups load in saved order (unplaced ones last, oldest first) and the split picker uses it', async () => {
  const api = app({tables: {
    users: [{user_id: 1, user_first_name: 'Bea', user_last_name: '', phone: null}],
    payment_methods: [], events: [],
    contacts: [{contact_id: 10, cont_first_name: 'Alex', cont_last_name: 'Lee', phone: null, contacts_payment_method: []}],
    friend_groups: [{group_id: 3, group_name: 'Family', position: 2, group_members: [{contact_id: 10}]},
                    {group_id: 5, group_name: 'Zoo trip', position: 1, group_members: [{contact_id: 10}]},
                    {group_id: 8, group_name: 'Newest', position: null, group_members: [{contact_id: 10}]},
                    {group_id: 7, group_name: 'Older', position: null, group_members: [{contact_id: 10}]}]}});
  api.S.userId = 1;
  await api.loadAll();
  assert.deepEqual(api.S.groups.map(g => g.name), ['Zoo trip', 'Family', 'Older', 'Newest']);
  const picker = api.pickerResults();
  assert.ok(picker.indexOf('Zoo trip') < picker.indexOf('Family') && picker.indexOf('Family') < picker.indexOf('Older'), 'not A–Z any more');
});
