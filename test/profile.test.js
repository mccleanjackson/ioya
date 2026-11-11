const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// A fake Supabase with a guest session that can be saved with an email, switched or signed out.
// `fail` makes one auth call return an error: {updateUser:'...'} etc.
// `avatar` starts the account with a saved photo. Storage calls are recorded too.
function fakeSupabase({fail = {}, saved = false, avatar = null} = {}){
  const calls = [];
  let nextUser = 7;
  const state = {session:{user:{id:'guest', is_anonymous:!saved, email:saved ? 'me@example.com' : '', created_at:'2026-11-02T10:00:00Z'}}, userId:7,
    paymentAccounts:{}, me:{user_first_name:'', user_last_name:'', phone:null}, avatar, files:avatar ? [avatar] : []};
  const err = name => fail[name] ? {error:{message:fail[name]}} : null;
  const query = rows => {
    const q = {select:() => q, eq:() => q, order:() => q,
      single:() => ({then:(f, r) => Promise.resolve({data:rows()[0], error:null}).then(f, r)}),
      then:(f, r) => Promise.resolve({data:rows(), error:null}).then(f, r)};
    return q;
  };
  const tables = {
    users:() => [{user_id:state.userId, ...state.me, avatar_path:state.avatar}],
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
      resetPasswordForEmail: async email => { calls.push(['resetPasswordForEmail', email]); return err('resetPasswordForEmail') || {data:{}, error:null}; },
      signInWithPassword: async args => {
        calls.push(['signInWithPassword', args]);
        if (fail.signInWithPassword) return {data:{}, error:{message:fail.signInWithPassword}};
        state.session = {user:{id:'saved', is_anonymous:false, email:args.email}}; state.userId = 3; state.me = {user_first_name:'Saved', user_last_name:'Me', phone:null};
        return {data:{}, error:null};
      },
      verifyOtp: async args => {
        calls.push(['verifyOtp', args]);
        if (fail.verifyOtp) return {data:{}, error:{message:fail.verifyOtp}};
        if (args.type === 'email_change') state.session = {user:{...state.session.user, is_anonymous:false, email:args.email}};
        else { state.session = {user:{id:'saved', is_anonymous:false, email:args.email}}; state.userId = 3; state.me = {user_first_name:'Saved', user_last_name:'Me', phone:null}; }  // 'recovery' logs in
        return {data:{}, error:null};
      }
    },
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'get_my_payment_accounts') return {data:state.paymentAccounts,error:null};
      if (name === 'get_my_payment_preference') return {data:state.paymentAccounts[state.preferred] ? state.preferred : null, error:null};
      if (name === 'set_my_payment_preference') {
        if (fail.set_my_payment_preference) return {data:null, error:{message:fail.set_my_payment_preference}};
        state.preferred = args.p_method; return {data:args.p_method, error:null};
      }
      if (name === 'save_my_payment_accounts') {
        if (fail.save_my_payment_accounts) return {data:null, error:{message:fail.save_my_payment_accounts}};
        state.paymentAccounts=args.p_accounts;
        return {data:state.paymentAccounts,error:null};
      }
      if (name === 'ensure_my_user') return {data:state.userId, error:null};
      if (name === 'set_my_avatar'){
        if (fail.set_my_avatar) return {data:null, error:{message:fail.set_my_avatar}};
        const old = state.avatar; state.avatar = args.p_path; return {data:old, error:null};
      }
      if (name === 'save_my_profile'){
        if (fail.save_my_profile) return {data:null, error:{message:fail.save_my_profile}};
        state.me = {user_first_name:args.p_first_name, user_last_name:args.p_last_name, phone:args.p_phone || null};
        return {data:null, error:null};
      }
      return {data:null, error:null};
    },
    from: name => query(tables[name]),
    storage:{from: bucket => ({
      getPublicUrl: p => ({data:{publicUrl:`https://example.test/storage/v1/object/public/${bucket}/${p}`}}),
      upload: async (p, blob, opts) => {
        calls.push(['upload', p, opts]);
        if (fail.upload) return {data:null, error:{message:fail.upload}};
        state.files.push(p); return {data:{path:p}, error:null};
      },
      remove: async paths => { calls.push(['remove', paths]); state.files = state.files.filter(f => !paths.includes(f)); return {data:[], error:null}; }
    })}
  };
  return {client, calls, state};
}

async function load(fake){
  const fields = {};
  const context = {
    window:{supabase:{createClient:() => fake.client}, IOYA_CONFIG:{supabaseUrl:'https://example.test', supabaseAnonKey:'test'}, IOYA_CLEAR_LOGIN_COOKIES:() => context.clearedCookies++},
    document:{getElementById:id => fields[id] || null, addEventListener:() => {}, querySelector:() => null},
    clearedCookies:0,
    localStorage:{getItem:() => null, setItem(){}},
    setTimeout:() => 0, clearTimeout:() => {}, console,
    // Just enough of the browser's image tools for the photo picker.
    createImageBitmap: async file => { if (file.unreadable) throw new Error('decode'); return {width:3000, height:2000, close(){}}; },
    URL:{createObjectURL:() => 'blob:preview', revokeObjectURL(){}},
    crypto:{randomUUID:() => '1b2c3d4e-0000-4000-8000-000000000001'}
  };
  context.document.createElement = () => ({getContext:() => ({fillRect(){}, drawImage:(...a) => context.drawn = a}),
    toBlob:(done, type, q) => done({type, size:48000})});
  const instrumented = script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {loadAll, S, ui, A, sheetHTML, liveCheck, V, choosePhoto, zoomCrop, clampCrop, payerAccountProblem, payerAccountValid, methodFor}; return;\nif (!V[S.view]");
  vm.runInNewContext(instrumented, context);
  const api = context.api;
  api.type = (values) => { for (const k of Object.keys(fields)) delete fields[k]; Object.entries(values).forEach(([id, value]) => fields[id] = {value, focus(){}}); };
  api.fields = fields;
  api.context = context;
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

test('a guest sees "Create profile" and a small "Log in" link; no "Log out"', async () => {
  const api = await load(fakeSupabase());
  open(api);
  const out = api.sheetHTML();
  assert.match(out, />Create profile</);
  assert.match(out, /Already have a profile\?.*>Log in</s);
  assert.match(out, /badge guest/);
  assert.doesNotMatch(out, /Log out|Change password/);
});

test('a logged-in user sees their email, "Change password" and "Log out", and no create or log-in buttons', async () => {
  const api = await load(fakeSupabase({saved:true}));
  open(api);
  const out = api.sheetHTML();
  assert.match(out, /Signed in as<\/span><b>me@example.com/);
  assert.match(out, /Verified/);
  assert.match(out, />Change password</);
  assert.match(out, />Log out</);
  assert.doesNotMatch(out, /Create profile|Already have a profile|>Log in</);
});

test('saving the profile sends trimmed values, reloads "You", and returns to view mode', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  api.type({'f-first':'  Jackson ', 'f-last':' McClean ', 'f-phone':' (801) 555-1234 '});
  await api.A.saveprofile();
  assert.deepEqual(plain(calls(fake, 'save_my_profile')[0][1]), {p_first_name:'Jackson', p_last_name:'McClean', p_phone:'(801) 555-1234'});
  assert.deepEqual(plain(api.S.me), {first:'Jackson', last:'McClean', phone:'(801) 555-1234', avatarUrl:null});
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

test('Create profile: name, email, 6-digit code, then a password; same account and data', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit', mode:'create'});
  assert.match(api.sheetHTML(), /Create your profile[\s\S]*Step 1 of 4/);
  api.type({'f-first':'Jackson', 'f-last':'McClean', 'f-phone':''});
  await api.A.saveprofile();
  assert.equal(api.ui.sheet.step, 'email');
  assert.match(api.sheetHTML(), /Add your email[\s\S]*Step 2 of 4/);
  api.type({'f-email':' Me@Example.com '});
  await api.A.sendcode({});
  assert.deepEqual(plain(calls(fake, 'updateUser')[0][1]), {email:'me@example.com'});
  assert.match(api.sheetHTML(), /Check your email[\s\S]*Step 3 of 4[\s\S]*>Continue</);
  api.type({'f-code':'123 456'});
  await api.A.verifycode();
  assert.deepEqual(plain(calls(fake, 'verifyOtp')[0][1]), {email:'me@example.com', token:'123456', type:'email_change'});
  assert.deepEqual(plain(api.S.account), {email:'me@example.com', guest:false, since:'2026-11-02T10:00:00Z'});
  assert.equal(api.ui.sheet.step, 'password');
  assert.match(api.sheetHTML(), /Choose a password[\s\S]*Step 4 of 4[\s\S]*>Create profile</);
  api.type({'f-password':'short', 'f-password2':'short'}); await api.A.savepassword({});
  assert.equal(errs(api).password, 'Passwords need at least 8 characters. This one has 5.');
  api.type({'f-password':'correct horse', 'f-password2':'correct hors'}); await api.A.savepassword({});
  assert.equal(errs(api).password2, "The two passwords don't match.");
  assert.equal(calls(fake, 'updateUser').length, 1, 'nothing sent while the passwords are wrong');
  api.type({'f-password':' correct horse ', 'f-password2':' correct horse '}); await api.A.savepassword({});
  assert.deepEqual(plain(calls(fake, 'updateUser')[1][1]), {password:' correct horse '}, 'passwords are not trimmed');
  assert.equal(api.S.userId, 7, 'same account');
  assert.equal(api.S.contacts.length, 1, 'contacts kept');
  assert.equal(api.ui.sheet.step, undefined, 'back to the profile view');
  assert.match(api.ui.toast, /Your profile is created/);
  assert.doesNotMatch(api.sheetHTML(), /Create profile/);
});

test('an email already used by a profile shows under the email field and points to Log in', async () => {
  const fake = fakeSupabase({fail:{updateUser:'A user with this email address has already been registered'}});
  const api = await load(fake);
  await toCode(api, 'taken@example.com');
  assert.match(errs(api).email, /already has an IOYA profile.*Log in/);
  assert.equal(api.ui.sheet.step, 'email');
  assert.match(api.sheetHTML(), /value="taken@example.com"/);
});

test('email, password and code mistakes get exact messages', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  api.type({'f-email':'', 'f-pw':''}); await api.A.login({});
  assert.deepEqual(errs(api), {email:'Email is required.', pw:'Enter your password.'});
  api.type({'f-email':'not-an-email', 'f-pw':'x'}); await api.A.login({});
  assert.equal(errs(api).email, 'Enter a full email address, like you@example.com.');
  assert.equal(calls(fake, 'signInWithPassword').length, 0);
  api.A.pstep({step:'email', mode:'reset'});
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

test('logging in with a password switches this browser to the profile, without creating an account', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  const out = api.sheetHTML();
  assert.match(out, /Log in[\s\S]*Your guest data stays behind[\s\S]*1 contact on this guest account/);
  assert.match(out, /id="f-pw" type="password"[^>]*autocomplete="current-password"/);
  assert.match(out, />Forgot password\?</);
  api.type({'f-email':' Saved@Example.com ', 'f-pw':'my secret pw'});
  await api.A.login({});
  assert.deepEqual(plain(calls(fake, 'signInWithPassword')[0][1]), {email:'saved@example.com', password:'my secret pw'});
  assert.equal(calls(fake, 'signInAnonymously').length, 0);
  assert.equal(api.S.userId, 3, 'now the saved profile');
  assert.equal(api.S.me.first, 'Saved');
  assert.equal(api.S.contacts.length, 0, "the guest's contacts are gone from the screen");
  assert.match(api.ui.toast, /Logged in as saved@example.com/);
});

test('a wrong password says so under the password field', async () => {
  const fake = fakeSupabase({fail:{signInWithPassword:'Invalid login credentials'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  api.type({'f-email':'me@example.com', 'f-pw':'nope'}); await api.A.login({});
  assert.match(errs(api).pw, /don't match an IOYA profile.*Forgot password/);
  assert.equal(api.S.userId, 7, 'still the guest');
});

test('Forgot password: email, code, then a new password, and you are logged in', async () => {
  const fake = fakeSupabase();
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'reset'});
  assert.match(api.sheetHTML(), /Reset your password/);
  api.type({'f-email':'saved@example.com'}); await api.A.sendcode({});
  assert.deepEqual(plain(calls(fake, 'resetPasswordForEmail')[0]), ['resetPasswordForEmail', 'saved@example.com']);
  api.type({'f-code':'654321'}); await api.A.verifycode();
  assert.equal(calls(fake, 'verifyOtp')[0][1].type, 'recovery');
  assert.equal(api.S.userId, 3, 'the code logged in to the profile');
  assert.equal(api.ui.sheet.step, 'password');
  assert.match(api.sheetHTML(), /Choose a new password[\s\S]*>Save password</);
  api.type({'f-password':'new password 1', 'f-password2':'new password 1'}); await api.A.savepassword({});
  assert.deepEqual(plain(calls(fake, 'updateUser')[0][1]), {password:'new password 1'});
  assert.match(api.ui.toast, /Password changed\. You're logged in as saved@example.com/);
});

test('a logged-in profile can change its password', async () => {
  const fake = fakeSupabase({saved:true, fail:{updateUser:'New password should be different from the old password.'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'password', mode:'change'});
  assert.match(api.sheetHTML(), /Change your password[\s\S]*>Cancel<[\s\S]*>Save password</);
  api.type({'f-password':'same old pw', 'f-password2':'same old pw'}); await api.A.savepassword({});
  assert.equal(errs(api).password, "That's already your password. Choose a different one.");
});

test('a dropped connection shows a plain message, not a technical one', async () => {
  const fake = fakeSupabase({fail:{updateUser:'Failed to fetch'}});
  const api = await load(fake);
  await toCode(api);
  assert.match(api.sheetHTML(), /<div class="alert bad" role="alert">Couldn&#39;t reach IOYA|<div class="alert bad" role="alert">Couldn't reach IOYA/);
});

test('logging in with an unconfirmed email says so under the email field', async () => {
  const fake = fakeSupabase({fail:{signInWithPassword:'Email not confirmed'}});
  const api = await load(fake);
  open(api); api.A.pstep({step:'email', mode:'signin'});
  api.type({'f-email':'new@example.com', 'f-pw':'whatever1'}); await api.A.login({});
  assert.match(errs(api).email, /hasn't been confirmed yet/);
});

test('logging out removes the login cookies and starts a fresh guest account', async () => {
  const fake = fakeSupabase({saved:true});
  const api = await load(fake);
  open(api); api.A.pstep({step:'signout'});
  assert.match(api.sheetHTML(), /Log out\?[\s\S]*log back in with me@example.com[\s\S]*removes the login cookies/);
  await api.A.signout();
  assert.deepEqual(plain(calls(fake, 'signOut')[0][1]), {scope:'local'});
  assert.equal(api.context.clearedCookies, 1, 'login cookies removed');
  assert.equal(calls(fake, 'signInAnonymously').length, 1);
  assert.equal(api.S.account.guest, true);
  assert.notEqual(api.S.userId, 7);
  assert.equal(api.ui.sheet, null);
  assert.match(api.ui.toast, /Logged out/);
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

// ---------- Profile pictures ----------
const PHOTO = {name:'me.jpg', type:'image/jpeg', size:3 * 1048576};  // the fake decodes every photo as 3000×2000
const PUBLIC = 'https://example.test/storage/v1/object/public/avatars/';
// A signed-in profile (guests can't add photos), in edit mode with name and phone unchanged.
async function editing(opts = {}){
  const fake = fakeSupabase({saved:true, ...opts});
  fake.state.me = {user_first_name:'Jackson', user_last_name:'McClean', phone:null};
  const api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  api.type({'f-first':'Jackson', 'f-last':'McClean', 'f-phone':''});
  return {fake, api};
}
// Choose a photo and press "Use photo" in the adjuster.
async function pick(api){ await api.choosePhoto(PHOTO); await api.A.cropdone(); }
const lastDraw = api => plain(api.context.drawn.slice(1)).map(n => Math.round(n));

test('a saved photo shows in the profile circle, over the initials', async () => {
  const api = await load(fakeSupabase({saved:true, avatar:'guest/old-photo-1.jpg'}));
  open(api);
  assert.equal(api.S.me.avatarUrl, PUBLIC + 'guest/old-photo-1.jpg');
  assert.match(api.sheetHTML(), /class="pava"[^>]*>.*<img class="face-img" src="https:\/\/example\.test\/storage\/v1\/object\/public\/avatars\/guest\/old-photo-1\.jpg"/s);
});

test('guests are told to create a profile and get no photo button', async () => {
  const fake = fakeSupabase(), api = await load(fake);
  open(api); api.A.pstep({step:'edit'});
  let out = api.sheetHTML();
  assert.match(out, /Create a profile to add a profile picture\./);
  assert.doesNotMatch(out, /Add photo|photo-in/);
  api.A.pstep({step:'edit', mode:'create'});
  assert.match(api.sheetHTML(), /You can add a profile picture once your profile is created\./);
  await api.choosePhoto(PHOTO);
  assert.ok(!api.ui.sheet.crop, 'a photo chosen anyway is ignored');
});

test('without a photo the edit form offers "Add photo" and no "Remove photo"', async () => {
  const {api} = await editing();
  const out = api.sheetHTML();
  assert.match(out, />Add photo</);
  assert.doesNotMatch(out, /Remove photo|face-img/);
});

test('choosing a photo opens the adjuster, centered and filling the circle', async () => {
  const {fake, api} = await editing();
  await api.choosePhoto(PHOTO);
  const c = api.ui.sheet.crop;
  assert.deepEqual([c.w, c.h, c.zoom, c.x, c.y], [3000, 2000, 1, -65, 0], 'shorter side fills the 260 px circle, centered');
  const out = api.sheetHTML();
  assert.match(out, /Adjust your photo/);
  assert.match(out, /id="crop-zoom"[^>]*type="range"|type="range"[^>]*id="crop-zoom"/);
  assert.match(out, />Use photo</);
  assert.doesNotMatch(out, /id="f-first"/, 'the name fields wait until the photo is done');
  await api.A.cropdone();
  assert.deepEqual(lastDraw(api), [500, 0, 2000, 2000, 0, 0, 400, 400], 'saved as the centered square, 400×400');
  assert.match(api.sheetHTML(), /src="blob:preview"[\s\S]*>Change photo<[\s\S]*>Adjust<[\s\S]*>Remove photo</);
  assert.equal(calls(fake, 'upload').length, 0, 'nothing uploaded until Save');
});

test('zooming and dragging change exactly what gets saved, and the photo always fills the circle', async () => {
  const {api} = await editing();
  await api.choosePhoto(PHOTO);
  const c = api.ui.sheet.crop;
  api.zoomCrop(c, 2);  // zoom in around the middle of the circle
  assert.equal(c.zoom, 2);
  await api.A.cropdone();
  assert.deepEqual(lastDraw(api), [1000, 500, 1000, 1000, 0, 0, 400, 400], 'the middle 1000×1000 of the photo');
  api.A.adjustphoto();
  c.x = 50; c.y = -99999; api.clampCrop(c);  // dragged too far right and up
  assert.deepEqual([c.x, c.y], [0, 260 - 2000 * 0.26], 'stops at the photo edges instead of showing a gap');
  api.zoomCrop(c, 9); assert.equal(c.zoom, 4, 'zoom stops at 4×');
  api.zoomCrop(c, 0.2); assert.equal(c.zoom, 1, "can't zoom out past filling the circle");
});

test('Cancel in the adjuster: a new photo is dropped; adjusting again keeps the earlier framing', async () => {
  const {api} = await editing();
  await api.choosePhoto(PHOTO);
  api.A.cropcancel();
  assert.equal(api.ui.sheet.crop, null);
  assert.equal(api.ui.sheet.photo, undefined, 'no photo was added');
  await pick(api);
  api.A.adjustphoto();
  api.zoomCrop(api.ui.sheet.crop, 3);
  api.A.cropcancel();
  assert.equal(api.ui.sheet.photo.source.zoom, 1, 'the earlier framing is kept');
});

test('Cancel on the form throws the chosen photo away; nothing is uploaded', async () => {
  const {fake, api} = await editing();
  await pick(api);
  api.A.pstep({});
  assert.equal(calls(fake, 'upload').length + calls(fake, 'set_my_avatar').length, 0);
  assert.equal(api.ui.sheet.photo, undefined);
});

test('Save uploads the photo to your own folder, sets it, and shows it', async () => {
  const {fake, api} = await editing({avatar:'guest/old-photo-1.jpg'});
  await pick(api);
  await api.A.saveprofile();
  const [, path, opts] = calls(fake, 'upload')[0];
  assert.equal(path, 'guest/1b2c3d4e-0000-4000-8000-000000000001.jpg');
  assert.equal(opts.contentType, 'image/jpeg');
  assert.deepEqual(plain(calls(fake, 'set_my_avatar')[0][1]), {p_path:path});
  assert.deepEqual(plain(calls(fake, 'remove')[0][1]), ['guest/old-photo-1.jpg'], 'old photo deleted');
  assert.equal(api.S.me.avatarUrl, PUBLIC + path);
  assert.equal(calls(fake, 'save_my_profile').length, 0, 'name and phone were unchanged');
  assert.equal(api.ui.sheet.step, null);
  assert.match(api.ui.toast, /Profile updated/);
});

test('Remove photo clears it on Save and deletes the old file', async () => {
  const {fake, api} = await editing({avatar:'guest/old-photo-1.jpg'});
  api.A.removephoto();
  assert.match(api.sheetHTML(), />Add photo</);
  assert.equal(calls(fake, 'set_my_avatar').length, 0, 'nothing changes until Save');
  await api.A.saveprofile();
  assert.deepEqual(plain(calls(fake, 'set_my_avatar')[0][1]), {p_path:null});
  assert.deepEqual(plain(calls(fake, 'remove')[0][1]), ['guest/old-photo-1.jpg']);
  assert.equal(api.S.me.avatarUrl, null);
});

test('files that are not photos, too large, or unreadable get exact red messages', async () => {
  const {fake, api} = await editing();
  await api.choosePhoto({name:'notes.pdf', type:'application/pdf', size:1000});
  assert.equal(errs(api).photo, "That file isn't a photo. Choose a JPG, PNG or HEIC image.");
  await api.choosePhoto({name:'huge.jpg', type:'image/jpeg', size:25 * 1048576});
  assert.equal(errs(api).photo, 'That photo is too large (25 MB). Choose one under 20 MB.');
  await api.choosePhoto({name:'odd.heic', type:'image/heic', size:1000, unreadable:true});
  assert.equal(errs(api).photo, "This browser couldn't open that photo. Try a JPG or PNG instead.");
  assert.match(api.sheetHTML(), /id="e-photo" role="alert">.*Try a JPG or PNG instead/s);
  assert.ok(!api.ui.sheet.crop, 'no adjuster for a bad file');
  await api.choosePhoto(PHOTO);
  assert.equal(errs(api).photo, '', 'a good photo clears the message');
  assert.equal(calls(fake, 'upload').length, 0);
});

test('a failed upload shows under the photo and keeps the form open', async () => {
  const {fake, api} = await editing({fail:{upload:'Failed to fetch'}});
  await pick(api);
  await api.A.saveprofile();
  assert.equal(errs(api).photo, "The photo couldn't be uploaded. Check your internet connection and try again.");
  assert.equal(calls(fake, 'set_my_avatar').length, 0);
  assert.equal(api.ui.sheet.step, 'edit');
  assert.equal(api.ui.saving, false);
});

test('if the database step is missing, the uploaded file is cleaned up and the fix is named', async () => {
  const {fake, api} = await editing({fail:{set_my_avatar:'Could not find the function public.set_my_avatar(p_path) in the schema cache'}});
  await pick(api);
  await api.A.saveprofile();
  assert.match(errs(api).photo, /Run supabase\/avatars\.sql/);
  assert.deepEqual(plain(calls(fake, 'remove')[0][1]), [calls(fake, 'upload')[0][1]], 'the new file is deleted again');
  assert.equal(fake.state.files.length, 0);
});

// ---------- Payment accounts ----------
async function payments(accounts = {}, preferred = null, fail = {}){
  const fake = fakeSupabase({saved:true, fail});
  Object.assign(fake.state, {paymentAccounts:accounts, preferred});
  const api = await load(fake);
  api.A.tab({v:'profile'});
  return {fake, api};
}
const perrs = api => plain(api.ui.profile.errs || {});  // the Profile tab keeps its state in ui.profile
const editPay = (api, values) => { api.A.pstep({step:'payments'}); Object.assign(api.ui.profile.paymentDraft, values); };

test('with no payment apps, the profile invites you to add one', async () => {
  const {api} = await payments();
  const out = api.V.profile();
  assert.match(out, /Link Venmo, Zelle or another app so friends can pay you\./);
  assert.match(out, /data-step="payments" data-add="1"[^>]*>.*Add a payment app/s);
  assert.doesNotMatch(out, /Not linked/);
});

test('linked apps show with their colors and readable handles; the preferred one is first with a star', async () => {
  const {api} = await payments({venmo:'jackson-m', zelle:'+18015551234', paypal:'me@example.com'}, 'zelle');
  const out = api.V.profile();
  const order = [...out.matchAll(/class="meth (\w+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['zelle', 'venmo', 'paypal'], 'preferred first, then the usual order');
  assert.match(out, /\(801\) 555-1234/, 'phone numbers are formatted');
  assert.match(out, /@jackson-m/, 'Venmo shows the @');
  assert.match(out, /class="meth zelle">Zelle<\/span>[\s\S]*?class="badge">.*Preferred/);
  assert.equal((out.match(/Preferred/g) || []).length, 1);
  assert.match(out, />Edit</);
  assert.match(out, /Add a payment app/, 'two apps are still unlinked');
});

test('every payment-account mistake gets its own exact message, and nothing is sent', async () => {
  const {fake, api} = await payments();
  editPay(api, {venmo:'@abc', paypal:'me@example', zelle:'801555123', cashapp:'$123', applecash:'0015551234'});
  await api.A.savePayerAccounts();
  assert.deepEqual(perrs(api), {
    'pay-venmo':'Venmo usernames are at least 5 characters. This one has 3.',
    'pay-paypal':'Enter a full email address, like you@example.com.',
    'pay-zelle':'U.S. mobile numbers have 10 digits. This one has 9.',
    'pay-cashapp':'$cashtags need at least one letter.',
    'pay-applecash':"That isn't a U.S. number: area codes can't start with 0 or 1."
  });
  assert.equal(calls(fake, 'save_my_payment_accounts').length, 0);
  assert.match(api.V.profile(), /id="e-pay-venmo" role="alert">.*at least 5 characters/s);
});

test('the exact messages agree with the rules used when sending requests', async () => {
  const {api} = await payments();
  const samples = ['abcd', 'abcde', '@abcde', 'has space', 'a'.repeat(31), 'a'.repeat(30), 'me@example.com', 'me@example', 'me@ex.c',
    'PayMe123', 'Pay.Me', 'p'.repeat(21), '8015551234', '18015551234', '+1 (801) 555-1234', '801-555-123', '1015551234', '0015551234',
    '$alex', '$123', '$a-b', '$' + 'a'.repeat(21), '#alex', '12345678901234567890123456789012345678901', 'x'.repeat(101)];
  for (const m of ['venmo', 'paypal', 'zelle', 'cashapp', 'applecash'])
    for (const v of samples)
      assert.equal(api.payerAccountProblem(m, v) === '', api.payerAccountValid(m, v), `${m}: "${v}"`);
});

test('a message clears as soon as the account is fixed', async () => {
  const {api} = await payments();
  editPay(api, {venmo:'abc'});
  await api.A.savePayerAccounts();
  assert.ok(perrs(api)['pay-venmo']);
  editPay(api, {venmo:'abcdef'});  // reopening the editor starts clean
  assert.deepEqual(perrs(api), {});
});

test('choosing a preferred app saves it, and an empty app cannot be preferred', async () => {
  const {fake, api} = await payments();
  editPay(api, {venmo:'jackson-m'}); api.ui.profile.prefDraft = 'zelle';
  await api.A.savePayerAccounts();
  assert.equal(perrs(api)['pay-zelle'], 'Add your Zelle account to make it your preferred app, or choose another.');
  assert.equal(calls(fake, 'save_my_payment_accounts').length, 0);
  api.ui.profile.prefDraft = 'venmo';
  await api.A.savePayerAccounts();
  assert.deepEqual(plain(calls(fake, 'set_my_payment_preference')[0][1]), {p_method:'venmo'});
  assert.equal(api.S.paymentPreferred, 'venmo');
  assert.match(api.ui.toast, /Payment accounts saved/);
  assert.match(api.V.profile(), /class="badge">.*Preferred/);
  editPay(api, {});  // save again without changing the preference
  await api.A.savePayerAccounts();
  assert.equal(calls(fake, 'set_my_payment_preference').length, 1, 'not sent again when unchanged');
});

test('a database message lands under the app it is about', async () => {
  const {api} = await payments({}, null, {save_my_payment_accounts:'Enter your Apple Cash U.S. mobile number.'});
  editPay(api, {applecash:'(801) 555-1234'});
  await api.A.savePayerAccounts();
  assert.deepEqual(perrs(api), {'pay-applecash':'Enter your Apple Cash U.S. mobile number.'});
});

test('if the preference update is missing, the accounts still save and the fix is named', async () => {
  const {api} = await payments({}, null, {set_my_payment_preference:'Could not find the function public.set_my_payment_preference(p_method) in the schema cache'});
  editPay(api, {venmo:'jackson-m'}); api.ui.profile.prefDraft = 'venmo';
  await api.A.savePayerAccounts();
  assert.equal(api.S.paymentAccounts.venmo, 'jackson-m');
  assert.match(api.ui.profile.alert, /Run supabase\/payment-preference\.sql/);
});

test('your preferred app is tried first for a contact who has no preference of their own', async () => {
  const {api} = await payments({venmo:'jackson-m', zelle:'+18015551234'}, null);
  api.S.contacts.push({id:'90', first:'Sam', last:'Lee', name:'Sam Lee', phone:'', venmo:'sam-lee-1', zelle:'sam@example.com', paypal:'', cashapp:'', applecash:'', method:'sms', pref:null, methods:[]});
  const p = {contactId:'90', method:'sms'};
  assert.equal(api.methodFor(p, 2000), 'venmo', 'no preference: the usual order');
  api.S.paymentPreferred = 'zelle';
  assert.equal(api.methodFor(p, 2000), 'zelle', 'your preferred app goes first');
  api.S.contacts.at(-1).method = 'venmo';
  assert.equal(api.methodFor({contactId:'90', method:'venmo'}, 2000), 'venmo', "the contact's own preference still wins");
});
