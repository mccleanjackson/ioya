const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// A fake Supabase: auth calls are recorded, table reads return the rows below.
// Like the real database's security rules, it returns only the signed-in user's own groups
// (none by default; pass groups to add some).
function fakeSupabase({session = null, signInError = null, ensure = [{data:7}], groups = []} = {}){
  const calls = [];
  const tables = {
    users:[{user_id:7, user_first_name:'', user_last_name:'', phone:null}],
    payment_methods:[{pay_method_id:1, pay_method_name:'Venmo'}],
    contacts:[{contact_id:50, cont_first_name:'', cont_last_name:'', phone:null, contacts_payment_method:[]}],
    friend_groups:groups,
    events:[{event_id:1, event_name:'Sunday brunch', participants:[], receipts:[{payer_user_id:1, receipt_date:'2026-09-16', line_items:[]}]}]
  };
  const query = rows => {
    const q = {select:() => q, eq:() => q, order:() => q,
      single:() => ({then:(f, r) => Promise.resolve({data:rows[0], error:null}).then(f, r)}),
      then:(f, r) => Promise.resolve({data:rows, error:null}).then(f, r)};
    return q;
  };
  const client = {
    auth:{
      getSession: async () => { calls.push('getSession'); return {data:{session}, error:null}; },
      signInAnonymously: async () => { calls.push('signInAnonymously'); return signInError ? {data:{}, error:{message:signInError}} : {data:{}, error:null}; },
      signOut: async () => { calls.push('signOut'); return {error:null}; }
    },
    rpc: async name => { calls.push(name); return {error:null, ...ensure.shift()}; },
    from: name => query(tables[name])
  };
  return {client, calls};
}

function load(fake){
  const context = {
    window:{supabase:{createClient:() => fake.client}, IOYA_CONFIG:{supabaseUrl:'https://example.test', supabaseAnonKey:'test'}},
    document:{getElementById:() => ({}), addEventListener:() => {}},
    localStorage:{getItem:() => null, setItem(){}},
    setTimeout, clearTimeout, console
  };
  const instrumented = script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {loadAll,S}; return;\nif (!V[S.view]");
  vm.runInNewContext(instrumented, context);
  return context.api;
}

// The last getSession reads whether the account is a guest or saved (Profile shows it).
test('a first visit signs in anonymously and acts as the new user, not the demo user', async () => {
  const fake = fakeSupabase();
  const api = load(fake);
  await api.loadAll();
  assert.deepEqual(fake.calls, ['getSession', 'signInAnonymously', 'ensure_my_user', 'getSession']);
  assert.equal(api.S.loadError, null);
  assert.equal(api.S.userId, 7);
  assert.equal(api.S.selfContactId, '50');
  assert.equal(api.S.contacts.length, 0);
  assert.equal(api.S.history.length, 0, "the demo user's splits are not shown");
  assert.equal(api.S.groups.length, 0, "the demo user's groups are not shown");
});

test("the user's own groups are shown, including a new empty one", async () => {
  const fake = fakeSupabase({groups:[{group_id:5, group_name:'Roommates', group_members:[{contact_id:50}]},
    {group_id:6, group_name:'New group', group_members:[]}]});
  const api = load(fake);
  await api.loadAll();
  assert.deepEqual(api.S.groups.map(g => [g.id, g.name, g.members.length]), [['5', 'Roommates', 0], ['6', 'New group', 0]],
    'both groups are kept; the "You" contact is not listed as a member');
});

test('a returning visitor keeps their saved session instead of getting a new account', async () => {
  const fake = fakeSupabase({session:{access_token:'saved'}});
  const api = load(fake);
  await api.loadAll();
  assert.deepEqual(fake.calls, ['getSession', 'ensure_my_user', 'getSession']);
  assert.equal(api.S.userId, 7);
});

test('reloading after setup does not sign in again', async () => {
  const fake = fakeSupabase();
  const api = load(fake);
  await api.loadAll();
  await api.loadAll();
  assert.equal(fake.calls.filter(c => c === 'signInAnonymously').length, 1);
});

test('a saved session for a deleted account starts a fresh account', async () => {
  const fake = fakeSupabase({session:{access_token:'stale'}, ensure:[{data:null, error:{code:'23503', message:'foreign key'}}, {data:8}]});
  const api = load(fake);
  await api.loadAll();
  assert.deepEqual(fake.calls, ['getSession', 'ensure_my_user', 'signOut', 'signInAnonymously', 'ensure_my_user', 'getSession']);
  assert.equal(api.S.userId, 8);
  assert.equal(api.S.loadError, null);
});

test('turned-off anonymous sign-ins show a clear error and no data', async () => {
  const fake = fakeSupabase({signInError:'Anonymous sign-ins are disabled'});
  const api = load(fake);
  await api.loadAll();
  assert.match(api.S.loadError, /Allow anonymous sign-ins/);
  assert.equal(api.S.userId, null);
  assert.equal(api.S.loading, false);
});

test('a database without the accounts SQL says which file to run', async () => {
  const fake = fakeSupabase({ensure:[{data:null, error:{code:'PGRST202', message:'Could not find the function public.ensure_my_user without parameters'}}]});
  const api = load(fake);
  await api.loadAll();
  assert.match(api.S.loadError, /anonymous-accounts\.sql/);
});
