// The settings page's own switch: a native button that names its state and label, and asks for the opposite state when it is clicked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { Switch } from '../dsh/src/client/switch.js';

const render = props => renderToString(React.createElement(Switch, { label: 'Show it', onChange: () => {}, ...props }));

test('the switch is a button with role switch whose aria-checked is the state it is given and whose accessible name is the label it is given, disabled when the owner disables it', () => {
  const on = render({ checked: true });
  assert.match(on, /^<button /);
  assert.match(on, /type="button"/);
  assert.match(on, /role="switch"/);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /aria-label="Show it"/);
  assert.doesNotMatch(on, /disabled/);
  assert.match(render({ checked: false }), /aria-checked="false"/);
  assert.match(render({ checked: false, disabled: true }), /disabled=""/);
});

test('a click asks for the opposite of the state shown', () => {
  for (const checked of [true, false]) {
    const asked = [];
    Switch({ checked, label: 'Show it', onChange: next => asked.push(next) }).props.onClick();
    assert.deepEqual(asked, [!checked]);
  }
});
