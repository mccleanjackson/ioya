const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// A fake Supabase with a guest session that can be saved with an email, switched or signed out.
// `fail` makes one auth call return an error: {updateUser:'...'} etc.
function fakeSupabase({fail = {}, saved = false} = {}){
  const calls = [];
  let nextUser = 7;
  const state = {session:{user:{id:'guest', is_anonymous:!saved, email:saved ? 'me@example.com' : ''}}, userId:7,
    me:{user_first_name:'', user_last_name:'', phone:null}};
  const err = name => fail[name] ? {error:{message:fail[name]}} : null;
  const query = rows => {
    const q = {select:() => q, eq:() => q, order:() => q,
      single:() => ({then:(f, r) => Promise.resolve({data:rows()[0], error:null}).then(f, r)}),
      then:(f, r) => Promise.resolve({data:rows(), error:null}).then(f, r)};
    return q;
  };
  const tables = {
    users:() => [{user_id:state.userId, ...state.me}],
    payment_methods:() => [{pay_method_id:1, pay_method_name:'Venmo'}],
    contacts:() => [{contact_id:50, cont_first_name:state.me.user_first_name, cont_last_name:state.me.user_last_name, phone:state.me.phone, contacts_payment_method:[]},
      ...(state.userId === 7 ? [{contact_id:51, cont_first_name:'Guest', cont_last_name:'Friend', phone:null, contacts_payment_method:[]}] : [])],
    friend_groups:() => [], events:() => []
  };
  const client = {
    auth:{
      getSession: async () => ({data:{session:state.session}, error:null}),
      signInAnonymously: async () => { calls.push(['signInAnonymously']); state.session = {user:{id:'guest2', is_anonymous:true}}; state.userId = ++nextUser + 10; return {data:{}, error:null}; },
      signOut: async opts => { calls.push(['signOut', opts]); state.session = null; return err('signOut') || {error:null}; },
      updateUser: async attrs => { calls.push(['updateUser', attrs]); return err('updateUser') || {data:{}, error:null}; },
      signInWithOtp: async args => { calls.push(['signInWithOtp', args]); return err('signInWithOtp') || {data:{}, error:null}; },
      verifyOtp: async args => {
        calls.push(['verifyOtp', args]);
        if (fail.verifyOtp) return {data:{}, error:{message:fail.verifyOtp}};
        if (args.type === 'email_change') state.session = {user:{id:'guest', is_anonymous:false, email:args.email}};
        else { state.session = {user:{id:'saved', is_anonymous:false, email:args.email}}; state.userId = 3; state.me = {user_first_name:'Saved', user_last_name:'Me', phone:null}; }
        return {data:{}, error:null};
      }
    },
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'ensure_my_user') return {data:state.userId, error:null};
      if (name === 'save_my_profile'){
        if (fail.save_my_profile) return {data:null, error:{message:fail.save_my_profile}};
        state.me = {user_first_name:args.p_first_name, user_last_name:args.p_last_name, phone:args.p_phone || null};
        return {data:null, error:null};
      }
      return {data:null, error:null};
    },
    from: name => query(tables[name])
  };
  return {client, calls, state};
}

async function load(fake){
  const fields = {};
  const context = {
    window:{supabase:{createClient:() => fake.client}, IOYA_CONFIG:{supabaseUrl:'https://example.test', supabaseAnonKey:'test'}},
    document:{getElementById:id => fields[id] || null, addEventListener:() => {}, querySelector:() => null},
    localStorage:{getItem:() => null, setItem(){}},
    setTimeout:() => 0, clearTimeout:() => {}, console
  };
  const instrumented = script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {loadAll, S, ui, A, sheetHTML}; return;\nif (!V[S.view]");
  vm.runInNewContext(instrumented, context);
  const api = context.api;
  api.type = (values) => { for (const k of Object.keys(fields)) delete fields[k]; Object.entries(values).forEach(([id, value]) => fields[id] = {value, focus(){}}); };
  await api.loadAll();
  return api;
}
const open = api => api.A.sheet({s:'profile'});
const calls = (fake, name) => fake.calls.filter(c => c[0] === name);
// Objects made inside the app's sandbox have different prototypes; compare them as plain data.
const plain = x => JSON.parse(JSON.stringify(x));

test('saving the profile sends trimmed values and reloads the renamed "You" contact', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api);
  api.type({'f-first':'  Jackson ', 'f-last':' McClean ', 'f-phone':' (801) 555-1234 '});
  await api.A.saveprofile();
  assert.deepEqual(plain(calls(fake, 'save_my_profile')[0][1]), {p_first_name:'Jackson', p_last_name:'McClean', p_phone:'(801) 555-1234'});
  assert.deepEqual(plain(api.S.me), {first:'Jackson', last:'McClean', phone:'(801) 555-1234'});
  assert.equal(api.S.selfContactId, '50', 'still finds "You" after the rename');
  assert.equal(api.ui.sheet, null);
  assert.match(api.ui.toast, /Saved your profile, Jackson/);
});

test('a blank first name or a bad phone is caught before saving, and the typed values stay', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api);
  api.type({'f-first':' ', 'f-last':'McClean', 'f-phone':''});
  await api.A.saveprofile();
  assert.match(api.ui.sheet.err, /Add your first name/);
  api.type({'f-first':'Jackson', 'f-last':'McClean', 'f-phone':'555-CALL'});
  await api.A.saveprofile();
  assert.match(api.ui.sheet.err, /7 to 15 digits/);
  assert.match(api.sheetHTML(), /value="555-CALL"/, 'what was typed is still in the field');
  assert.equal(calls(fake, 'save_my_profile').length, 0);
});

test('a database error keeps the form open with the message', async () => {
  const fake = fakeSupabase({fail:{save_my_profile:'One of your contacts already has this exact name and phone.'}});
  const api = await load(fake);
  open(api);
  api.type({'f-first':'Guest', 'f-last':'Friend', 'f-phone':''});
  await api.A.saveprofile();
  assert.match(api.ui.sheet.err, /already has this exact name/);
  assert.equal(api.ui.saving, false);
  assert.match(api.sheetHTML(), /value="Guest"/);
});

test('a guest saves their account: email, then the 6-digit code; same account and data', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api);
  assert.match(api.sheetHTML(), /Save your account/);
  api.A.pstep({step:'email', mode:'save'});
  api.type({'f-email':' Me@Example.com '});
  await api.A.sendcode({});
  assert.deepEqual(plain(calls(fake, 'updateUser')[0][1]), {email:'me@example.com'});
  assert.equal(api.ui.sheet.step, 'code');
  api.type({'f-code':'123 456'});
  await api.A.verifycode();
  assert.deepEqual(plain(calls(fake, 'verifyOtp')[0][1]), {email:'me@example.com', token:'123456', type:'email_change'});
  assert.deepEqual(plain(api.S.account), {email:'me@example.com', guest:false});
  assert.equal(api.S.userId, 7, 'same account');
  assert.equal(api.S.contacts.length, 1, 'contacts kept');
  open(api);
  assert.match(api.sheetHTML(), /Saved as<\/span><span>me@example.com/);
  assert.doesNotMatch(api.sheetHTML(), /Save your account/);
});

test('an email already used by a saved account points to Sign in', async () => {
  const fake = fakeSupabase({fail:{updateUser:'A user with this email address has already been registered'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'save'});
  api.type({'f-email':'taken@example.com'});
  await api.A.sendcode({});
  assert.match(api.ui.sheet.err, /Already saved\? Sign in/);
  assert.equal(api.ui.sheet.step, 'email');
  assert.match(api.sheetHTML(), /value="taken@example.com"/);
});

test('a wrong code shows a clear message and keeps the code', async () => {
  const fake = fakeSupabase({fail:{verifyOtp:'Token has expired or is invalid'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'save'});
  api.type({'f-email':'me@example.com'}); await api.A.sendcode({});
  api.type({'f-code':'111111'}); await api.A.verifycode();
  assert.match(api.ui.sheet.err, /wrong or has expired/);
  assert.match(api.sheetHTML(), /value="111111"/);
  assert.equal(api.S.account.guest, true);
  api.type({'f-code':'12'}); await api.A.verifycode();
  assert.match(api.ui.sheet.err, /6-digit code/);
  assert.equal(calls(fake, 'verifyOtp').length, 1, 'a too-short code is not sent');
});

test('"Send a new code" resends to the same email', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'save'});
  api.type({'f-email':'me@example.com'}); await api.A.sendcode({});
  api.type({}); await api.A.sendcode({again:'1'});
  assert.equal(calls(fake, 'updateUser').length, 2);
  assert.deepEqual(plain(calls(fake, 'updateUser')[1][1]), {email:'me@example.com'});
  assert.match(api.ui.toast, /Sent a new code/);
});

test('signing in to a saved account switches this browser to it, without creating an account', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  assert.match(api.sheetHTML(), /1 contact in this guest account won't move/);
  api.type({'f-email':'saved@example.com'});
  await api.A.sendcode({});
  assert.deepEqual(plain(calls(fake, 'signInWithOtp')[0][1]), {email:'saved@example.com', options:{shouldCreateUser:false}});
  api.type({'f-code':'654321'});
  await api.A.verifycode();
  assert.equal(calls(fake, 'verifyOtp')[0][1].type, 'email');
  assert.equal(api.S.userId, 3, 'now the saved account');
  assert.equal(api.S.me.first, 'Saved');
  assert.equal(api.S.contacts.length, 0, "the guest's contacts are gone from the screen");
  assert.match(api.ui.toast, /Signed in as saved@example.com/);
});

test('signing in with an unknown email says so', async () => {
  const fake = fakeSupabase({fail:{signInWithOtp:'Signups not allowed for otp'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  api.type({'f-email':'nobody@example.com'}); await api.A.sendcode({});
  assert.match(api.ui.sheet.err, /No saved account uses that email/);
});

test('an invalid email is caught before anything is sent', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'save'});
  api.type({'f-email':'not-an-email'}); await api.A.sendcode({});
  assert.match(api.ui.sheet.err, /full email address/);
  assert.equal(calls(fake, 'updateUser').length, 0);
});

test('signing out a saved account starts a fresh guest account', async () => {
  const fake = fakeSupabase({saved:true});
  const api = await load(fake);
  assert.equal(api.S.account.guest, false);
  open(api); api.A.pstep({step:'signout'});
  assert.match(api.sheetHTML(), /sign back in with me@example.com/);
  await api.A.signout();
  assert.deepEqual(plain(calls(fake, 'signOut')[0][1]), {scope:'local'});
  assert.equal(calls(fake, 'signInAnonymously').length, 1);
  assert.equal(api.S.account.guest, true);
  assert.notEqual(api.S.userId, 7);
  assert.equal(api.ui.sheet, null);
});

test('names and emails are escaped in the profile sheet', async () => {
  const fake = fakeSupabase({saved:true});
  fake.state.session.user.email = '<b>x</b>@example.com';
  fake.state.me = {user_first_name:'<img src=x>', user_last_name:'', phone:null};
  const api = await load(fake);
  open(api);
  const out = api.sheetHTML();
  assert.doesNotMatch(out, /<img src=x>|<b>x<\/b>/);
  assert.match(out, /&lt;img src=x&gt;/);
});
