const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/pay.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const id = '3fa08fd8-4263-4dc1-ae22-df3049f46f23';

async function mount(request, hash = '#' + id, preview = false){
  const nodes = new Map();
  const calls = [];
  const makeNode = () => ({
    children: [], get lastElementChild(){ return this.children.at(-1); }, dataset: {}, attributes: {}, hidden: true, open: false,
    classList: {toggle(){}},
    setAttribute(name, value){ this.attributes[name] = value; },
    removeAttribute(name){ delete this.attributes[name]; delete this[name]; },
    addEventListener(name, handler){ this[name] = handler; },
    querySelector(){ return {focus(){}}; },
    append(...children){ this.children.push(...children); },
    replaceChildren(...children){ this.children = children; },
    focus(){ this.focused = true; }
  });
  const get = key => {
    if (!nodes.has(key)) nodes.set(key, makeNode());
    return nodes.get(key);
  };
  await vm.runInNewContext(script, {
    document: {getElementById:get, createElement:makeNode},
    location: {hash},
    window: {IOYA_CONFIG:{preview}},
    URL, URLSearchParams,
    async fetch(url, options){
      calls.push({url, options});
      const payload = typeof request === 'function' ? await request(url) : request;
      return {ok:true, json:async () => payload};
    }
  });
  return {get, calls};
}

test('uses only payee accounts and exact USD amounts for payment handoffs', async () => {
  const {get} = await mount({
    amountCents:1234, payeeName:'<img src=x>', note:'Lunch & tip',
    methods:{venmo:'payee-name', paypal:'Payee', zelle:'owner@example.com', applePayUrl:'https://buy.stripe.com.example.org/fake'}
  });
  assert.equal(get('amount').textContent, '$12.34');
  assert.equal(get('payee').textContent, '<img src=x>');
  const [venmoRow,paypalRow,zelleRow] = get('options').children;
  const venmo = new URL(venmoRow.href);
  assert.equal(venmo.hostname, 'venmo.com');
  assert.equal(venmo.searchParams.get('txn'), 'pay');
  assert.equal(venmo.searchParams.get('recipients'), 'payee-name');
  assert.equal(venmo.searchParams.get('amount'), '12.34');
  assert.equal(venmo.searchParams.get('note'), 'Lunch & tip');
  assert.equal(get('options').children.length, 3);
  assert.equal(paypalRow.href, 'https://www.paypal.me/Payee/12.34USD');
  assert.equal(get('method').hidden, true);
  venmoRow.onclick();
  assert.equal(get('method').open, false);
  assert.equal(venmoRow.lastElementChild.textContent, '✓');
  zelleRow.onclick();
  assert.equal(zelleRow.href, undefined);
  assert.equal(get('method').open, true);
  assert.equal(get('target').textContent, 'owner@example.com');
});

test('account sharing requires a separate submission and handoff can continue independently', async () => {
  const {get, calls} = await mount({amountCents:100, payeeName:'Taylor', methods:{venmo:'Taylor'}});
  const [venmoRow] = get('options').children;
  const event = {preventDefault(){}};
  assert.equal(new URL(venmoRow.href).hostname, 'venmo.com');
  venmoRow.onclick();
  assert.equal(get('share').hidden, false);
  assert.equal(get('share').open, false);
  assert.equal(calls.length, 1);
  get('username').value = 'friend-account';
  await get('share-form').submit(event);
  assert.equal(calls[1].url, '/api/manual-requests/' + id + '/consent');
  assert.deepEqual(JSON.parse(calls[1].options.body), {method:'venmo', username:'friend-account'});
  assert.match(get('share-status').textContent, /were shared/);
});

test('missing request IDs never trigger a lookup', async () => {
  const {get, calls} = await mount(null, '');
  assert.equal(calls.length, 0);
  assert.match(get('status').textContent, /incomplete/);
});

test('preview renders providers but leaves outbound payment URLs unset', async () => {
  const {get} = await mount({
    amountCents:100, payeeName:'Taylor', methods:{paypal:'Payee', applePayUrl:'https://buy.stripe.com/example'}
  }, '#' + id, true);
  const rows = get('options').children;
  assert.equal(get('preview').hidden, false);
  assert.deepEqual(rows.map(row=>row.children[1].textContent), ['PayPal','Apple Pay']);
  assert.ok(rows.every(row=>row.href===undefined));
  rows[1].onclick();
  assert.equal(get('method-name').textContent, 'Apple Pay payment details');
});

test('a shared link shows only names until chosen and loads the chosen item breakdown', async () => {
  const secondId = 'eef9c7c3-5cf6-414b-a55f-9e82cc78ace1';
  const {get, calls} = await mount(url => {
    if (url.includes('/group/')) return {recipients:[{name:'<Alex>', id}, {name:'Casey', id:secondId}]};
    return {amountCents:1275, payeeName:'Taylor', items:[{name:'Soup', amountCents:1000},
      {name:'Tax, tip & fees', amountCents:275}], methods:{paypal:'Payee'}};
  }, '#group=' + id, true);

  assert.equal(calls[0].url, '/api/manual-requests/group/' + id);
  assert.equal(calls.length, 1);
  assert.equal(get('request').hidden, true);
  const [first, second] = get('names').children;
  assert.equal(first.textContent, '<Alex>');
  assert.equal(second.textContent, 'Casey');

  await second.onclick();
  assert.equal(calls[1].url, '/api/manual-requests/' + secondId);
  assert.equal(get('title').textContent, 'Share for Casey');
  assert.equal(get('amount').textContent, '$12.75');
  assert.equal(get('breakdown-section').hidden, false);
  assert.deepEqual(get('breakdown').children.map(row => row.children.map(cell => cell.textContent)),
    [['Soup', '$10.00'], ['Tax, tip & fees', '$2.75']]);
  assert.equal(get('options').children[0].href, undefined);
  get('back').click();
  assert.equal(get('request').hidden, true);
  assert.equal(get('chooser').hidden, false);
});

test('going back and picking another name ignores an earlier response', async () => {
  const secondId = 'eef9c7c3-5cf6-414b-a55f-9e82cc78ace1';
  let resolveFirst;
  const firstRequest = new Promise(resolve => { resolveFirst = resolve; });
  const {get} = await mount(url => {
    if (url.includes('/group/')) return {recipients:[{name:'Alex', id}, {name:'Casey', id:secondId}]};
    if (url.endsWith(id)) return firstRequest;
    return {amountCents:250, payeeName:'Taylor'};
  }, '#group=' + id);

  const [first, second] = get('names').children;
  const pending = first.onclick();
  get('back').click();
  await second.onclick();
  resolveFirst({amountCents:1000, payeeName:'Taylor'});
  await pending;
  assert.equal(get('title').textContent, 'Share for Casey');
  assert.equal(get('amount').textContent, '$2.50');
  assert.equal(get('breakdown-section').hidden, true);
});

test('Cash App, Apple Cash and PayPal email show copyable accounts and native app instructions', async () => {
  const methods = {cashapp:'$TestPayer', applecash:'+18015550102', paypal:'payer@example.com'};
  const {get} = await mount({amountCents:1234, payeeName:'Taylor', methods});
  const options = get('options').children;
  assert.deepEqual(options.map(option => option.children[1].textContent), ['PayPal', 'Cash App', 'Apple Cash']);

  for (const [index, account, instruction] of [[0, methods.paypal, /Open Send in PayPal/],
    [1, methods.cashapp, /Open Cash App/], [2, methods.applecash, /open Messages/]]) {
    options[index].onclick();
    assert.equal(get('target').textContent, account);
    assert.equal(get('method-amount').textContent, '$12.34');
    assert.equal(get('open-provider').hidden, true);
    assert.equal(get('open-provider').href, undefined);
    assert.match(get('instructions').textContent, instruction);
    assert.equal(get('method-app').href, ['https://www.paypal.com/myaccount/transfer/','https://cash.app/login','sms:+18015550102'][index]);
  }
  assert.equal(get('share').hidden, true);
  const small = await mount({amountCents:99, payeeName:'Taylor', methods});
  assert.deepEqual(small.get('options').children.map(option => option.children[1].textContent), ['PayPal', 'Apple Cash']);
});
