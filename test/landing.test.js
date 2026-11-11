const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
// Objects made inside the sandbox have different prototypes; compare them as plain data.
const plain = x => JSON.parse(JSON.stringify(x));
const tick = () => new Promise(r => setTimeout(r, 0));

// Runs the landing page script against a fake page and a fake Supabase.
async function landing({session = null, admin = false, failLogin = null, row = {}} = {}){
  const calls = [], handlers = {}, els = {};
  const el = id => els[id] ||= {id, value:'', hidden:false, textContent:'', focus(){}, removeAttribute(){}, closest:() => ({classList:{remove(){}}})};
  const panel = Object.assign(el('panel'), {innerHTML:'', addEventListener:(t, f) => handlers[t] = f, querySelector:() => null});
  const users = {user_first_name:'Jackson', user_last_name:'McClean', is_admin:admin, avatar_path:null, ...row};
  const q = {select:() => q, eq:() => q, single:async () => ({data:users, error:null})};
  const client = {
    auth:{
      getSession:async () => ({data:{session}}),
      signInWithPassword:async args => { calls.push(['signInWithPassword', args]); if (failLogin) return {error:{message:failLogin}};
        session = {user:{email:args.email, is_anonymous:false}}; return {data:{}, error:null}; },
      signOut:async opts => { calls.push(['signOut', opts]); session = null; return {}; }
    },
    rpc:async name => { calls.push([name]); return {data:7, error:null}; },
    from:() => q,
    storage:{from:() => ({getPublicUrl:p => ({data:{publicUrl:'https://example.test/' + p}})})}
  };
  const context = {
    window:{supabase:{createClient:() => client}, IOYA_CONFIG:{supabaseUrl:'https://x.test', supabaseAnonKey:'k'}, IOYA_CLEAR_LOGIN_COOKIES:() => calls.push(['clearCookies'])},
    document:{getElementById:el}, setTimeout, console
  };
  vm.runInNewContext(script, context);
  await tick(); await tick();
  const submit = async (email, pw) => { el('f-email').value = email; el('f-pw').value = pw; handlers.submit({preventDefault(){}}); await tick(); await tick(); await tick(); };
  const click = async act => { handlers.click({target:{closest:sel => sel.includes(act) ? {} : null}}); await tick(); await tick(); };
  return {panel, calls, submit, click, nav:el('nav-account')};
}
const MAINTAIN = /Maintain Users[\s\S]*Maintain Contacts[\s\S]*Maintain Groups[\s\S]*Maintain Splits[\s\S]*Maintain Payment Methods/;

test('the landing page has a professional hero with an image, and a login form with user_email and user_password', async () => {
  assert.match(html, /<h1 id="hero-h">/);
  assert.match(html, /<img src="\/images\/ioya-review-and-send\.png"[^>]*alt="The IOYA Review and send screen/);
  assert.ok(fs.existsSync(path.join(__dirname, '../public/images/ioya-review-and-send.png')), 'the image file exists');
  const page = await landing();
  assert.match(page.panel.innerHTML, /name="user_email" type="email"/);
  assert.match(page.panel.innerHTML, /name="user_password" type="password"/);
  assert.doesNotMatch(page.panel.innerHTML, /Maintain|Log out/, 'no hidden buttons before logging in');
  assert.equal(page.nav.textContent, 'Log in');
});

test('a guest login counts as logged out', async () => {
  const page = await landing({session:{user:{is_anonymous:true}}});
  assert.match(page.panel.innerHTML, /name="user_password"/);
  assert.match(page.panel.innerHTML, /using IOYA as a guest/);
});

test('empty fields get exact red messages and nothing is sent', async () => {
  const page = await landing();
  await page.submit('', '');
  assert.match(page.panel.innerHTML, /Email is required\.[\s\S]*Enter your password\./);
  await page.submit('not-an-email', 'x');
  assert.match(page.panel.innerHTML, /Enter a full email address, like you@example\.com\./);
  assert.equal(page.calls.filter(c => c[0] === 'signInWithPassword').length, 0);
});

test('a wrong password shows a plain message and stays logged out', async () => {
  const page = await landing({failLogin:'Invalid login credentials'});
  await page.submit('me@example.com', 'wrong');
  assert.match(page.panel.innerHTML, /don&#39;t match an IOYA profile|don't match an IOYA profile/);
  assert.doesNotMatch(page.panel.innerHTML, /Maintain/);
});

test('an admin who logs in sees a Maintain button for every table, plus Log out', async () => {
  const page = await landing({admin:true});
  await page.submit(' Admin@Example.com ', 'pw 12345');
  assert.deepEqual(plain(page.calls.find(c => c[0] === 'signInWithPassword')[1]), {email:'admin@example.com', password:'pw 12345'});
  assert.match(page.panel.innerHTML, MAINTAIN);
  for (const k of ['users', 'contacts', 'groups', 'splits', 'methods']) assert.match(page.panel.innerHTML, new RegExp(`href="/admin#${k}"`));
  assert.match(page.panel.innerHTML, /Admin<\/span>[\s\S]*Logged in as admin@example\.com/);
  assert.match(page.panel.innerHTML, />Log out</);
  assert.equal(page.nav.textContent, 'Your account');
});

test('a regular user who logs in gets Open IOYA but no Maintain buttons', async () => {
  const page = await landing({admin:false});
  await page.submit('me@example.com', 'pw 12345');
  assert.match(page.panel.innerHTML, />Open IOYA</);
  assert.doesNotMatch(page.panel.innerHTML, /Maintain|Admin/);
});

test('Log out ends the login, removes the cookies and hides the buttons', async () => {
  const page = await landing({admin:true, session:{user:{email:'admin@example.com', is_anonymous:false}}});
  assert.match(page.panel.innerHTML, MAINTAIN, 'already logged in from an earlier visit');
  await page.click('logout');
  assert.deepEqual(plain(page.calls.slice(-2)), [['signOut', {scope:'local'}], ['clearCookies']]);
  assert.doesNotMatch(page.panel.innerHTML, /Maintain|Log out/);
  assert.match(page.panel.innerHTML, /name="user_password"/);
  assert.equal(page.nav.textContent, 'Log in');
});

test('names from the database are escaped', async () => {
  const page = await landing({admin:false, row:{user_first_name:'<img src=x onerror=alert(1)>'}, session:{user:{email:'a@b.co', is_anonymous:false}}});
  assert.doesNotMatch(page.panel.innerHTML, /<img src=x/);
  assert.match(page.panel.innerHTML, /&lt;img src=x/);
});
