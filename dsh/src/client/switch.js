// dsh/src/client/switch.js — the settings page's own two-state switch: the markup and behavior of the host's switch, a native `role="switch"` button, drawn by `.sw-set-switch` in `SETTINGS_CSS` over the theme tokens alone, so the plugin takes no code or styling from the host's primitives.
import React from 'react';

const h = React.createElement;

/**
 * A fully controlled switch: `checked` is the state shown, `label` the accessible name the owner localizes, `onChange` is called with the state a click, Enter or Space asks for, and `disabled` refuses all three.
 * The on and off look keys off `aria-checked`.
 */
export function Switch({ checked, onChange, label, disabled = false }) {
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, className: 'sw-set-switch', onClick: () => { onChange(!checked); },
  }, h('span', { className: 'sw-set-switch-thumb' }));
}
