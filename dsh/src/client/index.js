// dsh/src/client/index.js — the Cordis client plugin face: the one module that imports the bundler-only `styles.js`, the host's placement hooks and `createPortal`, binding them into `applyClient`.
import { IconGaugeOutlineMedium, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives';
import { createPortal } from 'react-dom';
import { applyClient } from './plugin.js';
import { TAB_CSS } from './styles.js';
import { SETTINGS_ENTRY } from './settings.js';

export const inject = ['slots', 'locale', 'theme', 'connection'];

export function apply(ctx) {
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: SETTINGS_ENTRY,
  }, IconGaugeOutlineMedium));
  applyClient(ctx, { tabCss: TAB_CSS, useAnchoredPosition, useDismissOnOutsidePointer, createPortal });
}
