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
  const state = {session:{user:{id:'guest', is_anonymous:!saved, email:saved ? 'me@example.com' : '', created_at:'2026-11-02T10:00:00Z'}}, userId:7,
    paymentAccounts:{}, me:{user_first_name:'', user_last_name:'', phone:null}};
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
        if (args.type === 'email_change') state.session = {user:{...state.session.user, is_anonymous:false, email:args.email}};
        else { state.session = {user:{id:'saved', is_anonymous:false, email:args.email}}; state.userId = 3; state.me = {user_first_name:'Saved', user_last_name:'Me', phone:null}; }
        return {data:{}, error:null};
      }
    },
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'get_my_payment_accounts') return {data:state.paymentAccounts,error:null};
      if (name === 'save_my_payment_accounts') {
        state.paymentAccounts=args.p_accounts;
        return {data:state.paymentAccounts,error:null};
      }
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
  const instrumented = script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {loadAll, S, ui, A, sheetHTML, liveCheck, V}; return;\nif (!V[S.view]");
  vm.runInNewContext(instrumented, context);
  const api = context.api;
  api.type = (values) => { for (const k of Object.keys(fields)) delete fields[k]; Object.entries(values).forEach(([id, value]) => fields[id] = {value, focus(){}}); };
  api.fields = fields;
  await api.loadAll();
  return api;
}
const open = api => api.A.sheet({s:'profile'});
const calls = (fake, name) => fake.calls.filter(c => c[0] === name);
// Objects made inside the app's sandbox have different prototypes; compare them as plain data.
const plain = x => JSON.parse(JSON.stringify(x));
const errs = api => plain(api.ui.sheet.errs || {});
// Walk a guest through steps 1 and 2 of "Create profile".
async function toCode(api, email = 'me@example.com'){
  open(api); api.A.pstep({step:'edit', mode:'create'});
  api.type({'f-first':'Jackson', 'f-last':'', 'f-phone':''}); await api.A.saveprofile();
  api.type({'f-email':email}); await api.A.sendcode({});
}

test('the profile opens in view mode with a pencil, not as a form', async () => {
  const api = await load(fakeSupabase());
  open(api);
  const out = api.sheetHTML();
  assert.match(out, /aria-label="Edit profile"/);
  assert.doesNotMatch(out, /id="f-first"/, 'no fields until the pencil is pressed');
  assert.match(out, /Add your name/);
  assert.match(out, /Member since November 2026/);
  api.A.pstep({step:'edit'});
  assert.match(api.sheetHTML(), /Edit profile[\s\S]*id="f-first"/);
});

test('a guest sees "Create profile" and a small "Sign in" link; no "Sign out"', async () => {
  const api = await load(fakeSupabase());
  open(api);
  const out = api.sheetHTML();
  assert.match(out, />Create profile</);
  assert.match(out, /Already have a profile\?.*>Sign in</s);
  assert.match(out, /badge guest/);
  assert.doesNotMatch(out, /Sign out/);
});

test('a signed-in user sees their email and "Sign out", and no create or sign-in buttons', async () => {
  const api = await load(fakeSupabase({saved:true}));
  open(api);
  const out = api.sheetHTML();
  assert.match(out, /Signed in as<\/span><b>me@example.com/);
  assert.match(out, /Verified/);
  assert.match(out, /Sign out/);
  assert.doesNotMatch(out, /Create profile|Already have a profile|>Sign in</);
});

test('saving the profile sends trimmed values, reloads "You", and returns to view mode', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  api.type({'f-first':'  Jackson ', 'f-last':' McClean ', 'f-phone':' (801) 555-1234 '});
  await api.A.saveprofile();
  assert.deepEqual(plain(calls(fake, 'save_my_profile')[0][1]), {p_first_name:'Jackson', p_last_name:'McClean', p_phone:'(801) 555-1234'});
  assert.deepEqual(plain(api.S.me), {first:'Jackson', last:'McClean', phone:'(801) 555-1234'});
  assert.equal(api.S.selfContactId, '50', 'still finds "You" after the rename');
  assert.equal(api.ui.sheet.step, null, 'back to view mode');
  assert.match(api.ui.toast, /Profile updated/);
  assert.match(api.sheetHTML(), /class="pname">Jackson McClean/);
});

test('each invalid field gets its own exact red message, and nothing is sent', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  const cases = [
    [{'f-first':' ', 'f-phone':''}, 'first', 'First name is required.'],
    [{'f-first':'J', 'f-phone':'123'}, 'phone', 'Phone number is too short: it has 3 digits, and it needs at least 7.'],
    [{'f-first':'J', 'f-phone':'1234567890123456'}, 'phone', 'Phone number is too long: it has 16 digits, and it can have at most 15.'],
    [{'f-first':'J', 'f-phone':'555-CALL-NOW'}, 'phone', 'Phone numbers can only use digits, spaces and ( ) + - .'],
    [{'f-first':'x'.repeat(51), 'f-phone':''}, 'first', 'First name can be at most 50 characters (it has 51).']
  ];
  for (const [values, k, msg] of cases){
    api.type({'f-last':'', ...values});
    await api.A.saveprofile();
    assert.equal(errs(api)[k], msg);
    const out = api.sheetHTML();
    assert.match(out, new RegExp(`id="w-${k}"[^>]*`), 'field wrapper present');
    assert.match(out, new RegExp(`class="field invalid" id="w-${k}"`), 'field outlined in red');
    assert.match(out, new RegExp(`<p class="ferr" id="e-${k}" role="alert">`), 'message visible');
  }
  assert.equal(calls(fake, 'save_my_profile').length, 0);
  assert.match(api.sheetHTML(), /value="x{51}"/, 'what was typed is still in the field');
});

test('a message clears as soon as the field is fixed', async () => {
  const api = await load(fakeSupabase());
  open(api); api.A.pstep({step:'edit'});
  api.type({'f-first':'J', 'f-last':'', 'f-phone':'12'}); await api.A.saveprofile();
  assert.ok(errs(api).phone);
  const box = {hidden:false, querySelector:() => ({textContent:''})}, wrap = {classList:{toggle(){}}};
  api.fields['e-phone'] = box; api.fields['w-phone'] = wrap;
  const input = {dataset:{f:'phone'}, value:'(801) 555-1234', setAttribute(){}, removeAttribute(){}};
  // The input listener calls liveCheck for data-in="pf" fields.
  api.ui.sheet && (api.ui.sheet.errs.phone = errs(api).phone);
  api.liveCheck(input);
  assert.equal(api.ui.sheet.errs.phone, '');
  assert.equal(box.hidden, true);
});

test('a database error lands under the field it is about', async () => {
  const fake = fakeSupabase({fail:{save_my_profile:'Enter a phone number with 7 to 15 digits, or leave it blank.'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  api.type({'f-first':'Guest', 'f-last':'Friend', 'f-phone':'(801) 555-1234'});
  await api.A.saveprofile();
  assert.match(errs(api).phone, /7 to 15 digits/);
  assert.equal(api.ui.saving, false);
  assert.match(api.sheetHTML(), /value="Guest"/);
});

test('an unrelated database error shows as a red box at the top', async () => {
  const fake = fakeSupabase({fail:{save_my_profile:'One of your contacts already has this exact name and phone.'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  api.type({'f-first':'Guest', 'f-last':'Friend', 'f-phone':''});
  await api.A.saveprofile();
  assert.match(api.sheetHTML(), /<div class="alert bad" role="alert">One of your contacts/);
});

test('Create profile: name, then email, then the 6-digit code; same account and data', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit', mode:'create'});
  assert.match(api.sheetHTML(), /Create your profile[\s\S]*Step 1 of 3/);
  api.type({'f-first':'Jackson', 'f-last':'McClean', 'f-phone':''});
  await api.A.saveprofile();
  assert.equal(api.ui.sheet.step, 'email');
  assert.match(api.sheetHTML(), /Add your email[\s\S]*Step 2 of 3/);
  api.type({'f-email':' Me@Example.com '});
  await api.A.sendcode({});
  assert.deepEqual(plain(calls(fake, 'updateUser')[0][1]), {email:'me@example.com'});
  assert.match(api.sheetHTML(), /Check your email[\s\S]*Step 3 of 3[\s\S]*>Create profile</);
  api.type({'f-code':'123 456'});
  await api.A.verifycode();
  assert.deepEqual(plain(calls(fake, 'verifyOtp')[0][1]), {email:'me@example.com', token:'123456', type:'email_change'});
  assert.deepEqual(plain(api.S.account), {email:'me@example.com', guest:false, since:'2026-11-02T10:00:00Z'});
  assert.equal(api.S.userId, 7, 'same account');
  assert.equal(api.S.contacts.length, 1, 'contacts kept');
  assert.equal(api.ui.sheet.step, undefined, 'back to the profile view');
  assert.match(api.ui.toast, /Your profile is created/);
  assert.doesNotMatch(api.sheetHTML(), /Create profile/);
});

test('an email already used by a profile shows under the email field and points to Sign in', async () => {
  const fake = fakeSupabase({fail:{updateUser:'A user with this email address has already been registered'}});
  const api = await load(fake);
  await toCode(api, 'taken@example.com');
  assert.match(errs(api).email, /already has an IOYA profile.*Sign in/);
  assert.equal(api.ui.sheet.step, 'email');
  assert.match(api.sheetHTML(), /value="taken@example.com"/);
});

test('email and code mistakes get exact messages', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  api.type({'f-email':''}); await api.A.sendcode({});
  assert.equal(errs(api).email, 'Email is required.');
  api.type({'f-email':'not-an-email'}); await api.A.sendcode({});
  assert.equal(errs(api).email, 'Enter a full email address, like you@example.com.');
  assert.equal(calls(fake, 'signInWithOtp').length, 0);
  api.type({'f-email':'me@example.com'}); await api.A.sendcode({});
  api.type({'f-code':'12'}); await api.A.verifycode();
  assert.equal(errs(api).code, 'The code is 6 digits. You entered 2.');
  api.type({'f-code':'12a456'}); await api.A.verifycode();
  assert.equal(errs(api).code, 'The code is numbers only.');
  assert.equal(calls(fake, 'verifyOtp').length, 0);
});

test('a wrong code shows under the code field and keeps the code', async () => {
  const fake = fakeSupabase({fail:{verifyOtp:'Token has expired or is invalid'}});
  const api = await load(fake);
  await toCode(api);
  api.type({'f-code':'111111'}); await api.A.verifycode();
  assert.match(errs(api).code, /wrong or has expired/);
  assert.match(api.sheetHTML(), /value="111111"/);
  assert.equal(api.S.account.guest, true);
});

test('"Send a new code" resends to the same email', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  await toCode(api);
  api.type({}); await api.A.sendcode({again:'1'});
  assert.equal(calls(fake, 'updateUser').length, 2);
  assert.deepEqual(plain(calls(fake, 'updateUser')[1][1]), {email:'me@example.com'});
  assert.match(api.ui.toast, /Sent a new code/);
});

test('signing in switches this browser to the profile, without creating an account', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  assert.match(api.sheetHTML(), /Your guest data stays behind[\s\S]*1 contact on this guest account/);
  api.type({'f-email':'saved@example.com'});
  await api.A.sendcode({});
  assert.deepEqual(plain(calls(fake, 'signInWithOtp')[0][1]), {email:'saved@example.com', options:{shouldCreateUser:false}});
  assert.match(api.sheetHTML(), />Sign in</);
  assert.doesNotMatch(api.sheetHTML(), /Step \d of 3/);
  api.type({'f-code':'654321'});
  await api.A.verifycode();
  assert.equal(calls(fake, 'verifyOtp')[0][1].type, 'email');
  assert.equal(api.S.userId, 3, 'now the saved profile');
  assert.equal(api.S.me.first, 'Saved');
  assert.equal(api.S.contacts.length, 0, "the guest's contacts are gone from the screen");
  assert.match(api.ui.toast, /Signed in as saved@example.com/);
});

test('a dropped connection shows a plain message, not a technical one', async () => {
  const fake = fakeSupabase({fail:{updateUser:'Failed to fetch'}});
  const api = await load(fake);
  await toCode(api);
  assert.match(api.sheetHTML(), /<div class="alert bad" role="alert">Couldn&#39;t reach IOYA|<div class="alert bad" role="alert">Couldn't reach IOYA/);
});

test('signing in with an unknown email says so under the email field', async () => {
  const fake = fakeSupabase({fail:{signInWithOtp:'Signups not allowed for otp'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  api.type({'f-email':'nobody@example.com'}); await api.A.sendcode({});
  assert.match(errs(api).email, /No saved profile uses this email/);
});

test('signing out starts a fresh guest account', async () => {
  const fake = fakeSupabase({saved:true});
  const api = await load(fake);
  open(api); api.A.pstep({step:'signout'});
  assert.match(api.sheetHTML(), /sign back in with me@example.com/);
  await api.A.signout();
  assert.deepEqual(plain(calls(fake, 'signOut')[0][1]), {scope:'local'});
  assert.equal(calls(fake, 'signInAnonymously').length, 1);
  assert.equal(api.S.account.guest, true);
  assert.notEqual(api.S.userId, 7);
  assert.equal(api.ui.sheet, null);
});

test('the profile page shows initials once there is a name', async () => {
  const fake = fakeSupabase();
  fake.state.me = {user_first_name:'Jackson', user_last_name:'McClean', phone:null};
  const api = await load(fake);
  assert.match(api.V.profile(), /class="pava" aria-hidden="true">JM</);
});

test('names and emails are escaped in the profile sheet', async () => {
  const fake = fakeSupabase({saved:true});
  fake.state.session.user.email = '<b>x</b>@example.com';
  fake.state.me = {user_first_name:'<img src=x>', user_last_name:'', phone:null};
  const api = await load(fake);
  open(api);
  const out = api.sheetHTML() + api.V.profile();
  assert.doesNotMatch(out, /<img src=x>|<b>x<\/b>/);
  assert.match(out, /&lt;img src=x&gt;/);
});

test('Profile tab shows the phone and account controls and saves payer identifiers',async()=>{
  const fake=fakeSupabase(),api=await load(fake);
  api.S.me.phone='8015550102';
  api.A.tab({v:'profile'});
  assert.equal(api.S.view,'profile');
  assert.match(api.V.profile(),/8015550102/);
  assert.match(api.V.profile(),/Create profile/);
  assert.match(api.V.profile(),/Payment accounts/);
  api.A.pstep({step:'payments'});
  assert.match(api.V.profile(),/Apple Cash/);
  api.ui.profile.paymentDraft.paypal='TaylorPreview';
  await api.A.savePayerAccounts();
  assert.equal(api.S.paymentAccounts.paypal,'TaylorPreview');
  assert.equal(calls(fake,'save_my_payment_accounts').length,1);
  assert.match(api.V.profile(),/TaylorPreview/);
});
