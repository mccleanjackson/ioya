const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

// Load the app with an optional saved draft in localStorage; startup stops before render/loadAll.
function load(saved){
  const context = {
    window:{}, document:{getElementById:() => ({}), addEventListener:() => {}},
    localStorage:{getItem:() => saved ? JSON.stringify(saved) : null, setItem(){}},
    setTimeout, clearTimeout, console
  };
  const instrumented = script.replace("if (!V[S.view]", "render = () => {}; globalThis.api = {go,A,S}; return;\nif (!V[S.view]");
  vm.runInNewContext(instrumented, context);
  return context.api;
}

test('the app has no built-in sample receipt', () => {
  assert.doesNotMatch(script, /Tony's Pizzeria|Pepperoni pizza|demoDraft|loadSample/);
});

test('a sample draft saved by an older version is dropped, not offered to resume', () => {
  const api = load({view:'assign', draft:{at:'assign', merchant:"Tony's Pizzeria", items:[{id:'i1', name:'Pepperoni pizza', price:1350}], people:[], assign:{}, fromSample:true}});
  assert.equal(api.S.draft.items.length, 0);
  assert.equal(api.S.draft.merchant, '');
});

test("the user's own unfinished split is still kept", () => {
  const api = load({view:'review', draft:{at:'review', merchant:'Maple Cafe', items:[{id:'i1', name:'Latte', price:450}], people:[], assign:{}}});
  assert.equal(api.S.draft.merchant, 'Maple Cafe');
  assert.equal(api.S.draft.items.length, 1);
});

test('opening a later split screen with an empty split goes to Check the items without filling anything in', () => {
  for (const v of ['people', 'assign', 'summary', 'sent']){
    const api = load();
    api.A.jump({v});
    assert.equal(api.S.view, 'review', v);
    assert.equal(api.S.draft.items.length, 0, v);
    assert.equal(api.S.draft.people.filter(p => p.name && !p.me).length, 0, v);
  }
});
