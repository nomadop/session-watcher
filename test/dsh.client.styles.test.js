// The DSH tab's stylesheet scoper, bridge, chrome and dock rules: the dashboard sheets wrapped in `@scope` with their keyframes hoisted, the dashboard variables redefined from the host's alias tokens on the tab root, the chrome leaf's rules, and the dock's rules under `[data-sw-dock]` in host variables alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeStylesheet, BRIDGE_CSS, CHROME_CSS, DOCK_CSS } from '../dsh/src/client/scope.js';

const WRAPPER = '@scope ([data-sw-tab]) {';

test('scopeStylesheet wraps the sheet in @scope, rewrites :root to :scope and hoists every @keyframes block before the wrapper', () => {
  const spin = '@keyframes sw-spin {\n  from { transform: rotate(0deg); }\n  to { transform: rotate(360deg); }\n}';
  const pulse = '@keyframes sw-pulse { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.4; } }';
  const body = 'body {\n  margin: 0;\n  padding: 24px 26px 50px;\n}';
  const nested = '@keyframes sw-narrow { from { opacity: 0; } to { opacity: 1; } }';
  const media = `@media (max-width: 760px) {\n  :root { --bg: #111; }\n  .a { color: red; }\n  ${nested}\n}`;
  const sheet = [
    '/* sheet */',
    ':root {\n  --bg: #000;\n}',
    body,
    spin,
    '.a { color: var(--bg); }',
    media,
    pulse,
  ].join('\n\n');

  const out = scopeStylesheet(sheet);
  const at = out.indexOf(WRAPPER);
  assert.ok(at > 0, 'the wrapper follows the hoisted blocks');
  const head = out.slice(0, at);
  assert.ok(head.indexOf(spin) >= 0 && head.indexOf(spin) < head.indexOf(pulse), 'both keyframes blocks hoisted in source order');
  assert.equal(head.replace(spin, '').replace(pulse, '').trim(), '', 'nothing but the keyframes before the wrapper');

  const tail = out.slice(at + WRAPPER.length).trimEnd();
  assert.ok(tail.endsWith('}'), 'the wrapper closes the sheet');
  const inner = tail.slice(0, -1);
  assert.equal(inner.includes(spin) || inner.includes(pulse), false, 'no top-level keyframes block stays inside');
  assert.equal(inner.includes(':root'), false);
  assert.ok(inner.includes(':scope {\n  --bg: #000;\n}'), 'the top-level :root rule is rewritten');
  assert.ok(inner.includes(`@media (max-width: 760px) {\n  :scope { --bg: #111; }\n  .a { color: red; }\n  ${nested}\n}`), 'the nested :root rule is rewritten and the nested keyframes block stays in its @media');
  assert.ok(inner.includes(body), 'the body rule stays inside with its text unchanged');
  assert.ok(inner.includes('.a { color: var(--bg); }'));
});

test('BRIDGE_CSS redefines the eight dashboard variables from their alias tokens by name and sets the root\'s color, flex, min-height, overflow-y, padding and the chat column\'s inline padding, nothing else', () => {
  const match = /^@scope \(\[data-sw-tab\]\) \{\s*:scope \{([^{}]*)\}\s*\}\s*$/.exec(BRIDGE_CSS);
  assert.ok(match, 'one :scope rule inside one @scope block');
  const declarations = Object.fromEntries(match[1].split(';').map(d => d.trim()).filter(Boolean).map((d) => {
    const colon = d.indexOf(':');
    return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
  }));
  assert.deepEqual(declarations, {
    '--bg': 'var(--dsw-alias-bg-base)',
    '--bg2': 'var(--dsw-alias-bg-layer-1)',
    '--card': 'var(--dsw-alias-bg-layer-2)',
    '--card2': 'var(--dsw-alias-bg-layer-3)',
    '--edge': 'var(--dsw-alias-border-l1)',
    '--txt': 'var(--dsw-alias-label-primary)',
    '--txt-dim': 'var(--dsw-alias-label-secondary)',
    '--mute': 'var(--dsw-alias-label-tertiary)',
    color: 'var(--txt)',
    flex: '1',
    'min-height': '0',
    'overflow-y': 'auto',
    padding: 'var(--sw-gutter)',
    'padding-inline': 'max(calc(var(--dsh-composer-side-clearance) + 16px), calc((100% - var(--dsh-chat-content-width)) / 2))',
  });
});

test('CHROME_CSS right-aligns the chrome leaf inside the tab scope and colours the pending, failing and unobserved badges, leaving live to the dashboard sheet', () => {
  assert.ok(CHROME_CSS.startsWith(WRAPPER));
  const rules = Object.fromEntries([...CHROME_CSS.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]));
  assert.match(rules['#sw-chrome'], /justify-content:\s*flex-end/);
  const ruleFor = state => Object.entries(rules).find(([selector]) => selector.split(',').map(part => part.trim()).includes(`.sw-chrome-conn[data-state="${state}"]`))?.[1];
  for (const state of ['connecting', 'reading']) assert.match(ruleFor(state), /color:\s*var\(--amber\)/, state);
  for (const state of ['disconnected', 'failed', 'unreachable']) assert.match(ruleFor(state), /color:\s*var\(--coral\)/, state);
  assert.match(ruleFor('unobserved'), /color:\s*var\(--mute\)/);
  assert.equal(Object.keys(rules).some(selector => selector.includes('"live"')), false);
});

test('DOCK_CSS scopes every rule to data-sw-dock, maps each zone to its host state colour, reads only host variables, keeps every full-round shape round, sets the pill\'s font on the button, and skins the popover with the host stat dialog\'s elevation', () => {
  const rules = [...DOCK_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(',').map(part => part.trim()),
    declarations: Object.fromEntries(body.split(';').map(d => d.trim()).filter(Boolean).map((d) => {
      const colon = d.indexOf(':');
      return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
    })),
  }));
  assert.ok(rules.length > 0);
  assert.equal(DOCK_CSS.replace(/[^{}]+\{[^{}]*\}/g, '').trim(), '', 'flat rules alone, no at-rule wrapper');
  for (const { selectors } of rules) {
    for (const selector of selectors) assert.match(selector, /^[a-z]*\[data-sw-dock\]/, 'every selector starts at a data-sw-dock element');
  }
  const zones = {
    white: 'var(--dsw-alias-label-tertiary)',
    green: 'var(--dsw-alias-state-success-primary)',
    amber: 'var(--dsw-alias-state-warn-primary)',
    red: 'var(--dsw-alias-state-error-primary)',
  };
  for (const [zone, token] of Object.entries(zones)) {
    const rule = rules.find(r => r.selectors.some(selector => selector.includes(`[data-zone="${zone}"]`)));
    assert.ok(rule, zone);
    assert.equal(rule.declarations.color, token, zone);
  }
  const variables = [...DOCK_CSS.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name);
  assert.ok(variables.length > 0);
  for (const name of variables) assert.match(name, /^--ds[wh]-/, 'a host variable');
  for (const { selectors, declarations } of rules) {
    const radius = declarations['border-radius'];
    if (radius === undefined || radius.startsWith('var(--dsw-radius-')) continue;
    assert.equal(declarations['corner-shape'], 'round', `${selectors[0]} keeps its ${radius} radius round under the host's superellipse`);
  }
  const pill = rules.find(r => r.selectors.includes('button[data-sw-dock]')).declarations;
  assert.match(pill['font-size'], /var\(--dsh-content-font-size-secondary/);
  assert.match(pill['line-height'], /var\(--dsh-content-font-delta-secondary/);
  const popover = rules.find(r => r.selectors.includes('div[data-sw-dock]')).declarations;
  assert.equal(popover['box-shadow'], 'var(--dsw-elevation-prominent)');
  assert.equal(popover['--dsw-elevation-stroke-color'], 'var(--dsw-alias-border-l1)');
  assert.equal(popover.border, '0');
});
