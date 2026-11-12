const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Maintain Contacts, Groups and Payment Methods (public/admin.html + supabase/admin-records.sql).
const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const plain = x => JSON.parse(JSON.stringify(x));
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const USERS = [
  {user_id:1, first_name:'Demo', last_name:'Payer', kind:'none'},
  {user_id:5, first_name:'Jackson', last_name:'McClean', kind:'admin'},
  {user_id:14, first_name:'', last_name:'', kind:'guest'}
];
const METHODS = [
  {pay_method_id:1, pay_method_name:'Venmo', built_in:true, contacts:3, payments:2},
  {pay_method_id:2, pay_method_name:'PayPal', built_in:true, contacts:0, payments:0},
  {pay_method_id:4, pay_method_name:'Cash', built_in:true, contacts:1, payments:0},
  {pay_method_id:7, pay_method_name:'Google Pay', built_in:false, contacts:0, payments:0},
  {pay_method_id:8, pay_method_name:'Wise', built_in:false, contacts:2, payments:0},
  {pay_method_id:9, pay_method_name:'Interac', built_in:false, contacts:0, payments:1}
];
const CONTACTS = [
  {contact_id:1, user_id:1, owner_first:'Demo', owner_last:'Payer', owner_kind:'none', first_name:'Demo', last_name:'Payer', phone:'(801) 555-0100', is_self:true, methods:[], groups:0, splits:3},
  {contact_id:2, user_id:1, owner_first:'Demo', owner_last:'Payer', owner_kind:'none', first_name:'Sam', last_name:'Lee', phone:null, is_self:false,
    methods:[{id:1, name:'Venmo', username:'@sam', preferred:true}, {id:4, name:'Cash', username:'Cash', preferred:false}], groups:1, splits:2},
  {contact_id:3, user_id:1, owner_first:'Demo', owner_last:'Payer', owner_kind:'none', first_name:'<i>Ann</i>', last_name:'', phone:null, is_self:false, methods:[], groups:1, splits:0},
  {contact_id:4, user_id:5, owner_first:'Jackson', owner_last:'McClean', owner_kind:'admin', first_name:'Cy', last_name:'', phone:null, is_self:false, methods:[], groups:0, splits:0}
];
const GROUPS = [
  {group_id:1, group_name:'Ski trip', user_id:1, owner_first:'Demo', owner_last:'Payer', owner_kind:'none',
    members:[{contact_id:3, first_name:'<i>Ann</i>', last_name:''}, {contact_id:2, first_name:'Sam', last_name:'Lee'}]},
  {group_id:2, group_name:'Empty', user_id:14, owner_first:'', owner_last:'', owner_kind:'guest', members:[]}
];

async function admin(hash, {fail = {}} = {}){
  const calls = [], els = {}, form = [];
  const el = id => els[id] ||= {id, innerHTML:'', value:'', focus(){}, setSelectionRange(){}, classList:{remove(){}}, removeAttribute(){}};
  const data = {admin_list_users:USERS, admin_list_contacts:CONTACTS, admin_list_groups:GROUPS, admin_list_payment_methods:METHODS};
  const client = {
    auth:{getSession:async () => ({data:{session:{user:{email:'jackson@example.com', is_anonymous:false}}}}), signOut:async () => ({})},
    rpc:async (name, args) => {
      calls.push([name, args]);
      if (fail[name]) return {data:null, error:{message:fail[name]}};
      if (name === 'is_admin') return {data:true, error:null};
      if (name === 'ensure_my_user') return {data:5, error:null};
      if (data[name]) return {data:structuredClone(data[name]), error:null};
      return {data:99, error:null};
    },
    storage:{from:() => ({getPublicUrl:p => ({data:{publicUrl:'https://example.test/' + p}})})}
  };
  const context = {
    window:{supabase:{createClient:() => client}, IOYA_CONFIG:{supabaseUrl:'https://x.test', supabaseAnonKey:'k'}, addEventListener(){}},
    document:{getElementById:el, addEventListener(){}, querySelector:() => null,
      querySelectorAll:sel => sel.includes('[data-list]') ? form.filter(x => x.dataset.list) : sel.includes('[data-f]') ? form.filter(x => x.dataset.f) : [],
      activeElement:null, body:{insertAdjacentHTML(){}}},
    location:{hash}, setTimeout, clearTimeout, console
  };
  vm.runInNewContext(script, context);
  const api = context.window.IOYA_ADMIN;
  await api.ready; await tick();
  const act = async (name, d = {}) => { await api.ACTIONS[name]({dataset:d}, {target:null}); await tick(); };
  // Fill the form: {first:'Pat', 'm-4':true, members:['2','3']} (arrays are checkbox lists).
  const fill = values => {
    form.length = 0;
    Object.entries(values).forEach(([f, v]) => {
      if (Array.isArray(v)) { form.push({dataset:{list:f}, type:'checkbox', checked:false, value:'0'}); v.forEach(x => form.push({dataset:{list:f}, type:'checkbox', checked:true, value:x})); }
      else form.push(typeof v === 'boolean' ? {dataset:{f}, type:'checkbox', checked:v} : {dataset:{f}, type:'text', value:v});
    });
  };
  return {api, calls, main:() => el('main').innerHTML, dialog:() => el('overlay').innerHTML, act, fill};
}
const rpcs = (page, name) => page.calls.filter(c => c[0] === name);

// ---------- Contacts ----------
test('Contacts: lists everyone\'s contacts with owner and payment apps, hides "You" rows by default, escapes names', async () => {
  const page = await admin('#contacts');
  const out = page.main();
  assert.match(out, /Maintain Contacts[\s\S]*Add contact/);
  assert.match(out, /Sam Lee[\s\S]*Demo Payer[\s\S]*#1[\s\S]*Venmo <span title="Preferred"[^>]*>★<\/span>, Cash/);
  assert.match(out, /&lt;i&gt;Ann&lt;\/i&gt;/);
  assert.doesNotMatch(out, /<i>Ann<\/i>/);
  assert.match(out, /Contacts<span class="n">3<\/span>[\s\S]*&quot;You&quot; contacts<span class="n">1<\/span>|Contacts<span class="n">3<\/span>[\s\S]*"You" contacts<span class="n">1<\/span>/);
  assert.match(out, /Showing 3 of 4 contacts/);
  assert.match(out, /data-act="askdelete" data-id="2"[^>]*disabled title="This contact is on a past split/);
  await page.act('filter', {k:'self'});
  assert.match(page.main(), /data-act="edit" data-id="1"[^>]*disabled title="This is their own &quot;You&quot; contact\. Change it in Maintain Users\."/);
  await page.act('edit', {id:'1'});
  assert.equal(page.api.ui.dlg, null, '"You" contacts can\'t be edited here');
});

test('Contacts: Add checks fields first, then sends the owner, names and payment apps', async () => {
  const page = await admin('#contacts');
  await page.act('add');
  assert.match(page.dialog(), /Belongs to[\s\S]*<optgroup label="People">[\s\S]*Demo Payer · #1 · No login[\s\S]*<optgroup label="Guests">[\s\S]*Guest · #14/);
  assert.match(page.dialog(), /Venmo[\s\S]*placeholder="@username"[\s\S]*Google Pay[\s\S]*Pays with cash[\s\S]*Preferred payment app/);
  page.fill({owner:'', first:'', last:'', phone:'12', pref:'7', 'm-1':'', 'm-7':'', 'm-4':false});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {owner:'Pick which user this belongs to.', first:'First name is required.',
    phone:'Phone number is too short: it has 2 digits, and it needs at least 7.', pref:'Add a Google Pay username, or pick a different preferred app.'});
  assert.equal(rpcs(page, 'admin_save_contact').length, 0);
  page.fill({owner:'5', first:'Pat', last:'Lee', phone:'', pref:'4', 'm-1':'@pat', 'm-7':'', 'm-4':true});
  await page.act('save');
  assert.deepEqual(plain(rpcs(page, 'admin_save_contact')[0][1]), {p_contact_id:null, p_user_id:5, p_first_name:'Pat', p_last_name:'Lee', p_phone:'',
    p_methods:[{pay_method_id:1, preferred:false, username:'@pat'}, {pay_method_id:4, preferred:true, username:'Cash'}]});
  assert.equal(page.api.ui.toast, 'Added Pat Lee.');
  assert.equal(rpcs(page, 'admin_list_contacts').length, 2, 'list reloaded');
});

test('Contacts: Edit shows the locked owner and saved usernames; a database message lands under its field', async () => {
  const page = await admin('#contacts', {fail:{admin_save_contact:'That\'s the same name and phone as the owner\'s own profile. Change the name or phone so IOYA can tell them apart.'}});
  await page.act('edit', {id:'2'});
  const d = page.dialog();
  assert.match(d, /Edit Sam Lee[\s\S]*id="f-owner"[^>]*disabled[\s\S]*can&#39;t be changed|id="f-owner"[^>]*disabled[\s\S]*can't be changed/);
  assert.match(d, /id="f-m-1"[^>]*value="@sam"/);
  assert.match(d, /id="f-m-4"[^>]*checked/);
  assert.match(d, /<option value="1" selected>Venmo/);
  page.fill({first:'Demo', last:'Payer', phone:'(801) 555-0100', pref:'1', 'm-1':'@sam', 'm-4':true});
  await page.act('save');
  assert.equal(rpcs(page, 'admin_save_contact')[0][1].p_user_id, 1, 'owner kept from the row');
  assert.deepEqual(Object.keys(page.api.ui.dlg.errs), ['first']);
});

test('Contacts: Delete says what goes with them', async () => {
  const page = await admin('#contacts');
  await page.act('askdelete', {id:'3'});
  assert.match(page.dialog(), /Delete &lt;i&gt;Ann&lt;\/i&gt;\?[\s\S]*from Demo Payer(?:'|&#39;)s contacts, and removes them from 1 group\./);
  await page.act('delete');
  assert.deepEqual(plain(rpcs(page, 'admin_delete_contact')[0][1]), {p_contact_id:3});
});

// ---------- Groups ----------
test('Groups: lists groups with owner and members', async () => {
  const page = await admin('#groups');
  const out = page.main();
  assert.match(out, /Maintain Groups[\s\S]*Ski trip[\s\S]*Demo Payer[\s\S]*&lt;i&gt;Ann&lt;\/i&gt;, Sam Lee[\s\S]*Empty[\s\S]*Guest/);
  await page.act('filter', {k:'empty'});
  assert.match(page.main(), /Showing 1 of 2 groups/);
});

test('Groups: members come from the chosen owner\'s contacts, without their "You" contact', async () => {
  const page = await admin('#groups');
  await page.act('add');
  assert.match(page.dialog(), /Pick an owner first/);
  page.api.ui.dlg.draft.owner = '1'; page.api.render();
  const d = page.dialog();
  assert.match(d, /value="2"[\s\S]*Sam Lee/);
  assert.match(d, /value="3"/);
  assert.doesNotMatch(d, /data-list="members" value="1"/, '"You" is not offered');
  assert.doesNotMatch(d, /value="4"/, "another user's contact is not offered");
  page.fill({owner:'1', name:'', members:['2']});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {name:'Group name is required.'});
  page.fill({owner:'1', name:'Lunch', members:['2', '3']});
  await page.act('save');
  assert.deepEqual(plain(rpcs(page, 'admin_save_group')[0][1]), {p_group_id:null, p_user_id:1, p_name:'Lunch', p_contact_ids:[2, 3]});
  assert.equal(page.api.ui.toast, 'Added Lunch.');
});

test('Groups: Edit keeps the owner, shows members checked, and an empty list is allowed', async () => {
  const page = await admin('#groups');
  await page.act('edit', {id:'1'});
  assert.match(page.dialog(), /value="2" checked[\s\S]*value="3" checked|value="3" checked[\s\S]*value="2" checked/);
  assert.match(page.dialog(), /2 contacts picked/);
  page.fill({name:'Ski', members:[]});  // every box unticked
  await page.act('save');
  assert.deepEqual(plain(rpcs(page, 'admin_save_group')[0][1]), {p_group_id:1, p_user_id:1, p_name:'Ski', p_contact_ids:[]});
  await page.act('askdelete', {id:'1'});
  assert.match(page.dialog(), /The contacts themselves are kept/);
});

// ---------- Payment methods ----------
test('Payment methods: built-ins are locked; added ones can be renamed, and deleted only when unused', async () => {
  const page = await admin('#methods');
  const out = page.main();
  assert.match(out, /Maintain Payment Methods[\s\S]*Venmo[\s\S]*Built in[\s\S]*Google Pay[\s\S]*Added/);
  assert.match(out, /data-act="edit" data-id="1"[^>]*disabled title="Venmo is built into IOYA, so it can&#39;t be renamed\."/);
  assert.match(out, /data-act="askdelete" data-id="1"[^>]*disabled/);
  assert.match(out, /data-act="askdelete" data-id="8"[^>]*disabled title="2 contacts still have a Wise username\. Remove it from them first\."/);
  assert.match(out, /data-act="askdelete" data-id="9"[^>]*disabled title="It was used to mark 1 payment as paid/);
  assert.doesNotMatch(out, /data-act="askdelete" data-id="7"[^>]*disabled/);
  await page.act('view', {id:'1'});
  assert.doesNotMatch(page.dialog(), /data-act="edit"/, 'no Edit button for built-ins');
  await page.act('close');
  await page.act('edit', {id:'7'});
  page.fill({name:'x'.repeat(31)});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {name:'Payment method names can be at most 30 characters (it has 31).'});
  page.fill({name:'Google Wallet'});
  await page.act('save');
  assert.deepEqual(plain(rpcs(page, 'admin_save_payment_method')[0][1]), {p_pay_method_id:7, p_name:'Google Wallet'});
  assert.equal(page.api.ui.toast, 'Saved Google Wallet.');
  await page.act('askdelete', {id:'7'});
  await page.act('delete');
  assert.deepEqual(plain(rpcs(page, 'admin_delete_payment_method')[0][1]), {p_pay_method_id:7});
});

test('Payment methods: a duplicate name from the database shows under Name', async () => {
  const page = await admin('#methods', {fail:{admin_save_payment_method:'There\'s already a payment method named Wise.'}});
  await page.act('add');
  page.fill({name:'wise'});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {name:'There\'s already a payment method named Wise.'});
});

test('a database without admin-records.sql names the file to run', async () => {
  const page = await admin('#groups', {fail:{admin_list_groups:'Could not find the function public.admin_list_groups without parameters in the schema cache'}});
  assert.match(page.main(), /run supabase\/admin-records\.sql/);
});
