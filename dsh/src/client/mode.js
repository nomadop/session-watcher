// dsh/src/client/mode.js — the session mode's two entries: the toggle a blank session shows in `conversation.hero.options` and the read-only mark a started session shows in `conversation.session.header.actions`.
// Both read the mode through the session's mode reader and render nothing while it holds no ready answer.
import React from 'react';

const h = React.createElement;

// The reader's latest result, starting from the one it holds.
function useReaderResult(reader) {
  const [result, setResult] = React.useState(() => reader.result);
  React.useEffect(() => reader.subscribe(setResult), [reader]);
  return result;
}

// The latest value of a boolean store.
function useFlag(store) {
  const [flag, setFlag] = React.useState(() => store.getSnapshot());
  React.useEffect(() => {
    setFlag(store.getSnapshot());
    return store.subscribe(() => { setFlag(store.getSnapshot()); });
  }, [store]);
  return flag;
}

/**
 * `ModeToggle({ reader, select, visibility, t })` renders a `role="switch"` button while the user's setting shows the option (`visibility`, a boolean store) and the reader's result is ready, unlocked and not invalid; its `aria-checked` is whether the mode is on, and a click calls `select(!on)`.
 * Hiding the option changes nothing but this button: a mode already chosen stands, and the mark below shows regardless.
 * A selection's reply, a failure envelope and a rejection included, changes nothing here: the switch shows the reader's result alone, which the session's own signal re-reads. The button is disabled only while its call is pending.
 */
export function ModeToggle({ reader, select, visibility, t }) {
  const result = useReaderResult(reader);
  const shown = useFlag(visibility);
  const [pending, setPending] = React.useState(false);
  if (!shown || result?.kind !== 'ready' || result.locked || result.mode === 'invalid') return null;
  const on = result.mode === 'on';
  const onClick = async () => {
    setPending(true);
    try {
      await select(!on);
    } catch {
      // The switch follows the reader, which a failed selection does not change.
    } finally {
      setPending(false);
    }
  };
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': on, 'data-sw-mode-toggle': '', disabled: pending, title: t('mode.toggleHint'), onClick,
  },
  h('span', { className: 'sw-mode-track', 'aria-hidden': 'true' }, h('i')),
  h('span', null, t('mode.toggle')));
}

/** `ModeMark({ reader, t })` renders a read-only mark while the reader's result is a ready on mode that is locked. */
export function ModeMark({ reader, t }) {
  const result = useReaderResult(reader);
  if (result?.kind !== 'ready' || result.mode !== 'on' || !result.locked) return null;
  return h('span', { 'data-sw-mode-mark': '', title: t('mode.markHint') }, t('mode.mark'));
}
