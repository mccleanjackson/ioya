const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Loading screen and screen-change animations in public/app.html.
const html = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');

test('the loading screen shows the logo, dots and a status message', () => {
  const fn = html.match(/function loadingScreen\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /class="app-loading" role="status"/);
  assert.match(fn, /app-loading-logo" src="\/ioya_logo.png" alt=""/);
  assert.match(fn, /Setting up your account…/);
  assert.match(fn, /Loading your splits…/);
  assert.match(html, /scr\.innerHTML = loading \? loadingScreen\(\)/);
});

test('screen changes animate only when the screen changes, and respect reduced motion', () => {
  assert.match(html, /v !== lastView \? \(from > 1 && to > 1 \? \(to > from \? 'view-fwd' : 'view-back'\) : 'view-in'\)/);
  for (const name of ['view-in', 'view-fwd', 'view-back']) {
    assert.match(html, new RegExp(`@keyframes ${name}\\{`));
    assert.match(html, new RegExp(`\\.screen\\.${name} > [^{]*\\{animation:${name} [^}]*backwards\\}`), name + ' leaves nothing transformed afterwards');
  }
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important/);
});
