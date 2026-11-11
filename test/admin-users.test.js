const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const plain = x => JSON.parse(JSON.stringify(x));
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const USERS = [
  {user_id:1, first_name:'Demo', last_name:'Payer', email:null, phone:'(801) 555-0100', is_admin:false, kind:'none', contacts:6, groups:2, splits:3, avatar_path:null},
  {user_id:5, first_name:'Jackson', last_name:'McClean', email:'jackson@example.com', phone:null, is_admin:true, kind:'admin', contacts:4, groups:1, splits:0, avatar_path:null},
  {user_id:12, first_name:'Tye', last_name:'Buckley', email:'tye@example.com', phone:null, is_admin:false, kind:'profile', contacts:7, groups:2, splits:1, avatar_path:null},
  {user_id:14, first_name:'', last_name:'', email:null, phone:null, is_admin:false, kind:'guest', contacts:1, groups:0, splits:0, avatar_path:null},
  {user_id:20, first_name:'<b>Bold</b>', last_name:'', email:null, phone:null, is_admin:false, kind:'none', contacts:1, groups:0, splits:0, avatar_path:null}
];

// Runs the admin page against a fake page and a fake database. `fail` makes one RPC return an error.
async function admin({isAdmin = true, fail = {}} = {}){
  const calls = [], els = {}, handlers = {}, form = [];
  const el = id => els[id] ||= {id, innerHTML:'', value:'', focus(){}, setSelectionRange(){}, classList:{remove(){}}, removeAttribute(){}};
  const client = {
    auth:{getSession:async () => ({data:{session:{user:{email:'jackson@example.com', is_anonymous:false}}}}), signOut:async () => ({})},
    rpc:async (name, args) => {
      calls.push([name, args]);
      if (fail[name]) return {data:null, error:{message:fail[name]}};
      if (name === 'is_admin') return {data:isAdmin, error:null};
      if (name === 'ensure_my_user') return {data:5, error:null};
      if (name === 'admin_list_users') return {data:USERS.map(u => ({...u})), error:null};
      return {data:99, error:null};
    },
    storage:{from:() => ({getPublicUrl:p => ({data:{publicUrl:'https://example.test/' + p}})})}
  };
  const context = {
    window:{supabase:{createClient:() => client}, IOYA_CONFIG:{supabaseUrl:'https://x.test', supabaseAnonKey:'k'}, addEventListener(){}},
    document:{getElementById:el, addEventListener:(t, f) => handlers[t] = f, querySelector:() => null,
      querySelectorAll:sel => sel.startsWith('#dlg-form') ? form : [], activeElement:null, body:{insertAdjacentHTML(){}}},
    location:{hash:'#users'}, setTimeout, clearTimeout, console
  };
  vm.runInNewContext(script, context);
  const api = context.window.IOYA_ADMIN;
  await api.ready; await tick();
  const act = async (name, data = {}) => { await api.ACTIONS[name]({dataset:data}, {target:null}); await tick(); };
  // Fill the add/edit form: {first:'Pat', is_admin:true, …}
  const fill = values => { form.length = 0; Object.entries(values).forEach(([f, v]) => form.push(typeof v === 'boolean' ? {dataset:{f}, type:'checkbox', checked:v} : {dataset:{f}, type:'text', value:v})); };
  return {api, calls, els, main:() => el('main').innerHTML, dialog:() => el('overlay').innerHTML, act, fill, handlers};
}
const rpcs = (page, name) => page.calls.filter(c => c[0] === name);

test('only admins get in', async () => {
  const page = await admin({isAdmin:false});
  assert.match(page.main(), /Admins only[\s\S]*jackson@example\.com is not an admin account/);
  assert.equal(rpcs(page, 'admin_list_users').length, 0);
});

test('the list shows people with their type and counts, hides guests by default, and escapes names', async () => {
  const page = await admin();
  const out = page.main();
  assert.match(out, /Maintain Users[\s\S]*Add user/);
  assert.match(out, /Demo Payer[\s\S]*No login[\s\S]*Jackson McClean[\s\S]*>You<[\s\S]*Admin[\s\S]*Tye Buckley[\s\S]*Profile/);
  assert.doesNotMatch(out, /Guest \(no name\)/, 'guests are hidden under People');
  assert.match(out, /People<span class="n">4<\/span>[\s\S]*Guests<span class="n">1<\/span>[\s\S]*Everyone<span class="n">5<\/span>/);
  assert.match(out, /Showing 4 of 5 users/);
  assert.match(out, /&lt;b&gt;Bold&lt;\/b&gt;/);
  assert.doesNotMatch(out, /<b>Bold<\/b>/);
  assert.match(out, /data-act="askdelete" data-id="5"[^>]*disabled title="You can&#39;t delete your own account\."/);
});

test('filters, search and sorting', async () => {
  const page = await admin();
  await page.act('filter', {k:'guest'});
  assert.match(page.main(), /Guest \(no name\)/);
  assert.match(page.main(), /Showing 1 of 5 users/);
  await page.act('filter', {k:'all'});
  page.api.ui.q = 'buckley'; page.api.render();
  assert.match(page.main(), /Showing 1 of 5 users/);
  page.api.ui.q = ''; await page.act('sort', {k:'name'});
  const names = () => page.api.visibleRows().map(r => r.user_id);
  assert.deepEqual(names(), [14, 20, 1, 5, 12], 'by name A→Z (no name first)');
  await page.act('sort', {k:'name'});
  assert.deepEqual(names(), [12, 5, 1, 20, 14], 'then Z→A');
});

test('Add user: exact red messages, and nothing is sent until they are fixed', async () => {
  const page = await admin();
  await page.act('add');
  assert.match(page.dialog(), /Add user[\s\S]*First name[\s\S]*Email[\s\S]*Phone[\s\S]*Admin/);
  page.fill({first:'', last:'', email:'pat@', phone:'12', is_admin:false});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {first:'First name is required.', email:'Enter a full email address, like name@example.com.',
    phone:'Phone number is too short: it has 2 digits, and it needs at least 7.'});
  assert.match(page.dialog(), /id="e-first" role="alert"[^>]*>.*First name is required\./s);
  assert.equal(rpcs(page, 'admin_save_user').length, 0);
});

test('Add user saves, closes, says so, and reloads the list', async () => {
  const page = await admin();
  await page.act('add');
  page.fill({first:'Pat', last:'Lee', email:' Pat@Example.COM ', phone:'(801) 555-0000', is_admin:true});
  await page.act('save');
  assert.deepEqual(plain(rpcs(page, 'admin_save_user')[0][1]),
    {p_user_id:null, p_first_name:'Pat', p_last_name:'Lee', p_email:'pat@example.com', p_phone:'(801) 555-0000', p_is_admin:true});
  assert.equal(page.api.ui.dlg, null);
  assert.equal(page.api.ui.toast, 'Added Pat Lee.');
  assert.equal(rpcs(page, 'admin_list_users').length, 2, 'list reloaded');
});

test('Edit: a login email is locked, your own admin box is locked, and a database message lands under its field', async () => {
  const page = await admin({fail:{admin_save_user:'Another user already has this email.'}});
  await page.act('edit', {id:'12'});
  assert.match(page.dialog(), /Edit Tye Buckley[\s\S]*id="f-email"[^>]*disabled[\s\S]*Only they can change it/);
  await page.act('close');
  await page.act('edit', {id:'5'});
  assert.match(page.dialog(), /id="f-is_admin"[^>]*checked\s+disabled[\s\S]*can&#39;t remove your own admin access|id="f-is_admin"[^>]*checked\s+disabled[\s\S]*can't remove your own admin access/);
  await page.act('close');
  await page.act('edit', {id:'1'});
  page.fill({first:'Demo', last:'Payer', email:'tye@example.com', phone:'', is_admin:false});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {email:'Another user already has this email.'});
  assert.equal(page.api.ui.dlg.busy, false);
});

test('Delete explains exactly what goes, then deletes', async () => {
  const page = await admin();
  await page.act('askdelete', {id:'5'});
  assert.equal(page.api.ui.dlg, null, "can't open delete for yourself");
  await page.act('askdelete', {id:'12'});
  assert.match(page.dialog(), /Delete Tye Buckley\?[\s\S]*7 contacts, 2 groups and 1 split\.[\s\S]*Their login stays in Supabase[\s\S]*can&#39;t be undone|can't be undone/);
  await page.act('delete');
  assert.deepEqual(plain(rpcs(page, 'admin_delete_user')[0][1]), {p_user_id:12});
  assert.equal(page.api.ui.toast, 'Deleted Tye Buckley.');
});

test('a failed delete keeps the dialog open with the reason', async () => {
  const page = await admin({fail:{admin_delete_user:'Failed to fetch'}});
  await page.act('askdelete', {id:'1'});
  await page.act('delete');
  assert.match(page.dialog(), /Couldn&#39;t reach IOYA|Couldn't reach IOYA/);
  assert.equal(page.api.ui.dlg.busy, false);
});

test('a database without admin-users.sql names the file to run', async () => {
  const page = await admin({fail:{admin_list_users:'Could not find the function public.admin_list_users without parameters in the schema cache'}});
  assert.match(page.main(), /run supabase\/admin-users\.sql/);
});
