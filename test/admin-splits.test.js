const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Maintain Splits (public/admin.html + supabase/admin-splits.sql).
const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const plain = x => JSON.parse(JSON.stringify(x));
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const USERS = [{user_id:1, first_name:'Demo', last_name:'Payer', kind:'none'}, {user_id:5, first_name:'Jackson', last_name:'McClean', kind:'admin'}];
const own = {user_id:1, owner_first:'Demo', owner_last:'Payer', owner_kind:'none', phone:null, methods:[], groups:0, splits:0};
const CONTACTS = [
  {...own, contact_id:1, first_name:'Demo', last_name:'Payer', is_self:true},
  {...own, contact_id:2, first_name:'Sam', last_name:'Lee', is_self:false},
  {...own, contact_id:3, first_name:'<i>Ann</i>', last_name:'', is_self:false},
  {contact_id:9, user_id:5, owner_first:'Jackson', owner_last:'McClean', owner_kind:'admin', first_name:'Cy', last_name:'', is_self:false, phone:null, methods:[], groups:0, splits:0}
];
const METHODS = [{pay_method_id:1, pay_method_name:'Venmo', built_in:true}, {pay_method_id:4, pay_method_name:'Cash', built_in:true}];
const receipt = (over = {}) => ({receipt_id:10, payer_user_id:1, merchant_name:'Sakura Ramen', receipt_date:'2026-09-11', tax_cents:300, fees_cents:0, tip_percent:0, tip_cents:0, total_cents:3300,
  items:[{item_id:1, description:'Ramen', price_cents:2000, position:1, shares:[{contact_id:2, share_cents:2000}]},
         {item_id:2, description:'Gyoza', price_cents:1000, position:2, shares:[{contact_id:1, share_cents:500}, {contact_id:3, share_cents:500}]}], ...over});
const SPLITS = [
  {event_id:1, event_name:'Ramen night', ...own, receipts:[receipt()],
    people:[{contact_id:1, first_name:'Demo', last_name:'Payer', paid_method_id:null, is_self:true}, {contact_id:2, first_name:'Sam', last_name:'Lee', paid_method_id:1, is_self:false},
            {contact_id:3, first_name:'<i>Ann</i>', last_name:'', paid_method_id:null, is_self:false}]},
  {event_id:2, event_name:'Two receipts', ...own, receipts:[receipt({receipt_id:11}), receipt({receipt_id:12, merchant_name:'Cafe'})], people:[]}
];

async function admin(hash, {fail = {}} = {}){
  const calls = [], els = {}, form = [];
  const el = id => els[id] ||= {id, innerHTML:'', value:'', focus(){}, setSelectionRange(){}, classList:{remove(){}}, removeAttribute(){}};
  const data = {admin_list_users:USERS, admin_list_contacts:CONTACTS, admin_list_splits:SPLITS, admin_list_payment_methods:METHODS};
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
  const pick = attr => sel => sel.includes(`[data-${attr}]`) ? form.filter(x => x.dataset[attr] !== undefined) : null;
  const context = {
    window:{supabase:{createClient:() => client}, IOYA_CONFIG:{supabaseUrl:'https://x.test', supabaseAnonKey:'k'}, addEventListener(){}},
    document:{getElementById:el, addEventListener(){}, querySelector:() => null,
      querySelectorAll:sel => pick('item')(sel) || pick('paid')(sel) || pick('list')(sel) || pick('f')(sel) || [],
      activeElement:null, body:{insertAdjacentHTML(){}}},
    location:{hash}, setTimeout, clearTimeout, console
  };
  vm.runInNewContext(script, context);
  const api = context.window.IOYA_ADMIN;
  await api.ready; await tick();
  const act = async (name, d = {}) => { await api.ACTIONS[name]({dataset:d}, {target:null}); await tick(); };
  // Fill the split form. items: [{desc, price, people:['2']}], paid: {'2':'1'}
  const fill = ({items = [], paid = {}, ...fields}) => {
    form.length = 0;
    Object.entries(fields).forEach(([f, v]) => form.push({dataset:{f}, type:'text', value:v}));
    items.forEach((it, i) => {
      form.push({dataset:{item:String(i), k:'desc'}, value:it.desc}, {dataset:{item:String(i), k:'price'}, value:it.price});
      ['1', '2', '3'].forEach(c => form.push({dataset:{item:String(i), person:c}, type:'checkbox', checked:it.people.includes(c)}));
    });
    Object.entries(paid).forEach(([c, m]) => form.push({dataset:{paid:c}, value:m}));
  };
  return {api, calls, main:() => el('main').innerHTML, dialog:() => el('overlay').innerHTML, act, fill};
}
const rpcs = (page, name) => page.calls.filter(c => c[0] === name);
const base = {owner:'1', sname:'Lunch', merchant:'Cafe Rio', date:'2026-11-01', tax:'1.00', fees:'', tip:'2.00', total:''};

test('Splits: the list shows payer, merchant, total with tip, and how many have paid back', async () => {
  const page = await admin('#splits');
  const out = page.main();
  assert.match(out, /Maintain Splits[\s\S]*Add split/);
  assert.match(out, /Ramen night[\s\S]*Demo Payer[\s\S]*Sakura Ramen[\s\S]*Sep 11, 2026[\s\S]*\$33\.00[\s\S]*1 of 2/);
  assert.match(out, /Two receipts[\s\S]*Sakura Ramen \+ Cafe[\s\S]*\$66\.00/);
  assert.match(out, /data-act="edit" data-id="2"[^>]*disabled title="This split has more than one receipt/);
  await page.act('filter', {k:'waiting'});
  assert.match(page.main(), /Showing 1 of 2 splits/);
});

test('Splits: View shows items, who shares them, and what each person owes with tax shared by what they ordered', async () => {
  const page = await admin('#splits');
  await page.act('view', {id:'1'});
  const d = page.dialog();
  assert.match(d, /Ramen, \$20\.00: Sam Lee/);
  assert.match(d, /Gyoza, \$10\.00: You, &lt;i&gt;Ann&lt;\/i&gt;/);
  // Tax $3 shared 2000:500:500 → Sam 22.00, You 5.50, Ann 5.50
  assert.match(d, /Sam Lee<\/dt><dd>\$22\.00 · Paid with Venmo/);
  assert.match(d, /&lt;i&gt;Ann&lt;\/i&gt;<\/dt><dd>\$5\.50 · Not paid yet/);
  assert.match(d, /Demo Payer \(payer\)<\/dt><dd>\$5\.50 \(their own share\)/);
});

test('Splits: Add checks every field and item before sending anything', async () => {
  const page = await admin('#splits');
  await page.act('add');
  assert.match(page.dialog(), /class="dlg wide"[\s\S]*Paid by[\s\S]*Split name[\s\S]*Merchant[\s\S]*Receipt date[\s\S]*Items[\s\S]*Pick who paid first/);
  page.fill({owner:'', sname:'', merchant:'', date:'', tax:'abc', fees:'', tip:'', total:'', items:[{desc:'', price:'', people:[]}, {desc:'Tea', price:'3', people:[]}]});
  await page.act('save');
  assert.deepEqual(plain(page.api.ui.dlg.errs), {owner:'Pick who paid.', sname:'Split name is required.', merchant:'Merchant is required.',
    date:'Receipt date is required.', tax:'Tax: enter dollars and cents, like 12.50.', 'item-0':'Item 1: add a description.', 'item-1':'Item 2: pick who shares it.'});
  assert.equal(rpcs(page, 'admin_save_split').length, 0);
});

test('Splits: Add sends the split in cents, with each item\'s people and who has paid', async () => {
  const page = await admin('#splits');
  await page.act('add');
  page.api.ui.dlg.draft.owner = '1'; page.api.render();
  const d = page.dialog();
  assert.match(d, /data-person="1"[^>]*>You \(Demo Payer\)[\s\S]*data-person="3"[\s\S]*data-person="2"/, 'payer first, then contacts by name');
  assert.doesNotMatch(d, /data-person="9"/, "another user's contact isn't offered");
  page.fill({...base, items:[{desc:'Burrito', price:'$12.50', people:['2']}, {desc:'Chips', price:'4', people:['1', '2', '3']}], paid:{'2':'1', '3':''}});
  await page.act('save');
  assert.deepEqual(plain(rpcs(page, 'admin_save_split')[0][1]), {p_event_id:null, p_user_id:1, p_split:{name:'Lunch', merchant:'Cafe Rio', date:'2026-11-01',
    tax_cents:100, fees_cents:0, tip_cents:200, total_cents:null,
    items:[{description:'Burrito', price_cents:1250, contact_ids:[2]}, {description:'Chips', price_cents:400, contact_ids:[1, 2, 3]}], paid:{'2':1}}});
  assert.equal(page.api.ui.toast, 'Added Lunch.');
});

test('Splits: the live summary adds up, shares tax by what each ordered, and offers a paid dropdown for everyone but the payer', async () => {
  const page = await admin('#splits');
  await page.act('edit', {id:'1'});
  const d = page.dialog();
  assert.match(d, /id="f-item-0"[^>]*value="Ramen"[\s\S]*value="20\.00"/);
  assert.match(d, /Items<\/span><b>\$30\.00[\s\S]*Tax<\/span><b>\$3\.00[\s\S]*Total paid<\/span><b>\$33\.00/);
  assert.match(d, /Sam Lee<\/span>\s*<span class="amt">\$22\.00[\s\S]*<option value="1" selected>Paid with Venmo/);
  assert.doesNotMatch(d, /data-paid="1"/, 'no paid dropdown for the payer');
  assert.match(d, /id="f-owner"[^>]*disabled/);
});

test('Splits: add and remove item rows keep what was typed', async () => {
  const page = await admin('#splits');
  await page.act('edit', {id:'1'});
  page.fill({sname:'Ramen night', merchant:'Sakura Ramen', date:'2026-09-11', tax:'3.00', fees:'', tip:'', total:'33.00',
    items:[{desc:'Ramen!', price:'20', people:['2']}, {desc:'Gyoza', price:'10', people:['1', '3']}]});
  await page.act('additem');
  assert.equal(page.api.ui.dlg.draft.items.length, 3);
  assert.equal(page.api.ui.dlg.draft.items[0].desc, 'Ramen!');
  // The browser now shows the new, empty row too.
  page.fill({sname:'Ramen night', merchant:'Sakura Ramen', date:'2026-09-11', tax:'3.00', fees:'', tip:'', total:'33.00',
    items:[{desc:'Ramen!', price:'20', people:['2']}, {desc:'Gyoza', price:'10', people:['1', '3']}, {desc:'', price:'', people:[]}]});
  await page.act('rmitem', {i:'0'});
  assert.deepEqual(plain(page.api.ui.dlg.draft.items.map(i => i.desc)), ['Gyoza', '']);
});

test('Splits: a database message about an item lands under that item; delete says what goes', async () => {
  const page = await admin('#splits', {fail:{admin_save_split:"Item 1: everyone must be one of the payer's contacts. Refresh the page and try again."}});
  await page.act('edit', {id:'1'});
  page.fill({...base, items:[{desc:'Ramen', price:'20', people:['2']}]});
  await page.act('save');
  assert.deepEqual(Object.keys(page.api.ui.dlg.errs), ['item-0']);
  await page.act('close');
  await page.act('askdelete', {id:'1'});
  assert.match(page.dialog(), /deletes the split Ramen night \(Sakura Ramen, Sep 11, 2026\): 2 items and the paid records for 2 people\. It disappears from Demo Payer(?:'|&#39;)s History/);
  await page.act('delete');
  assert.deepEqual(plain(rpcs(page, 'admin_delete_split')[0][1]), {p_event_id:1});
});

test('a database without admin-splits.sql names the file to run', async () => {
  const page = await admin('#splits', {fail:{admin_list_splits:'Could not find the function public.admin_list_splits without parameters in the schema cache'}});
  assert.match(page.main(), /run supabase\/admin-splits\.sql/);
});
