// dsh/src/client/index.js — the Cordis client plugin face: the one module that imports the bundler-only `styles.js`, the host's placement hooks and `createPortal`, binding them into `applyClient`.
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives';
import { createPortal } from 'react-dom';
import { applyClient } from './plugin.js';
import { TAB_CSS } from './styles.js';

export const inject = ['slots', 'locale', 'theme', 'connection'];

export function apply(ctx) {
  applyClient(ctx, { tabCss: TAB_CSS, useAnchoredPosition, useDismissOnOutsidePointer, createPortal });
}
