const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production parser without needing Supabase, a DOM or OCR downloads.
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('function parseReceiptText('), html.indexOf('/* ---------- end receipt text parser'));
const parse = vm.runInNewContext(`(${source})`);
const read = text => JSON.parse(JSON.stringify(parse(text)));

test('extracts real items and cents, not subtotal, payment or change', () => {
  const r = read("MAPLE CAFE\n123 Main Street\nOrder 42\n2 Lattes 9.50\nBagel $4.25\nSubtotal 13.75\nSales Tax 1.10\nService Fee 0.50\nTOTAL $15.35\nVISA 15.35\nChange 0.00\nSuggested Tip 2.75");
  assert.equal(r.merchant, 'MAPLE CAFE');
  assert.deepEqual(r.items, [{name:'2 Lattes', price:950}, {name:'Bagel', price:425}]);
  assert.equal(r.tax, 110);
  assert.equal(r.fees, 50);
  assert.equal(r.printed, 1535);
  assert.equal(r.warnings.length, 1);
});

test('does not guess missing prices or the receipt total', () => {
  const r = read('CORNER SHOP\nTea 2.50\nSandwich price unreadable\nTax 0.20');
  assert.deepEqual(r.items, [{name:'Tea', price:250}]);
  assert.equal(r.printed, 0);
  assert.match(r.warnings.join(' '), /total was not found/);
});

test('ignores discounts and included tips instead of silently charging them as items', () => {
  const r = read('LUNCH BAR\nBurger 12.00\nPromo -1.00\nDiscount 2.00\nGratuity 2.40\nTOTAL 13.40');
  assert.deepEqual(r.items, [{name:'Burger', price:1200}]);
  assert.match(r.warnings.join(' '), /discount or refund/i);
  assert.match(r.warnings.join(' '), /tip or gratuity/i);
});

test('handles CRLF, thousands, price flags and several tax lines', () => {
  const r = read('EVENT CATERING\r\nBuffet $1,250.00 T\r\nState Tax 50.00\r\nLocal Tax 12.50\r\nGrand Total $1,312.50');
  assert.deepEqual(r.items, [{name:'Buffet', price:125000}]);
  assert.equal(r.tax, 6250);
  assert.equal(r.printed, 131250);
});

test('blank/non-receipt text yields no fake sample items', () => {
  for (const text of ['', 'unreadable photo', 'TOTAL 0.00\nCash 0.00']) assert.equal(read(text).items.length, 0);
});

test('hyphenated subtotal is not mistaken for the final total', () => {
  const r = read('LOCAL CAFE\nTea 2.50\nSub-Total 2.50\nTax 0.20\nBalance Due 2.70');
  assert.equal(r.items.length, 1);
  assert.equal(r.tax, 20);
  assert.equal(r.printed, 270);
});
