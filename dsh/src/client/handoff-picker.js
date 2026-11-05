// dsh/src/client/handoff-picker.js — the `/sw-load` bare-invocation picker: a popup over the project's handoff catalog whose selection fills the draft with the chosen token's load command and runs nothing.
import { stateText } from './locales.js';

/** The host command this decorates. */
const COMMAND = 'sw-load';
const LIST_ENDPOINT = 'handoff/list';
const DETAIL_SEPARATOR = ' · ';

/**
 * Hangs the picker on the host's `/sw-load` for the injection child that reads `commandUi`, `sessions` and `conversation`.
 * The popup lists what `handoff/list` answers in the order it answers, an undelivered and a delivered group, each row the token with the age the Host computed before its task; the popup's own substring search reaches both.
 *
 * @param {object} child - the injection child
 * @param {{ call: (endpoint: string, payload: object, signal: AbortSignal) => Promise<object>, t: Function }} options
 */
export function registerHandoffPicker(child, { call, t }) {
  const { commandUi, sessions, conversation } = child;
  commandUi.decorate({
    name: COMMAND,
    available: () => true,
    ui: {
      kind: 'popupSelect',
      searchLabels: () => ({ placeholder: t('picker.search'), empty: t('picker.empty'), noResults: t('picker.noResults') }),
      async options({ sessionId }, signal) {
        const reply = await call(LIST_ENDPOINT, { sessionId }, signal);
        // The popup shows a rejection's message and offers a retry; neither answer stands in for a catalog.
        if (reply.ok !== true) throw new Error(stateText({ kind: 'unreachable', message: reply.error.message }, t));
        if (reply.value.state !== 'live') {
          throw new Error(stateText({ kind: 'state', state: reply.value.state, diagnostic: reply.value.diagnostic }, t));
        }
        const groups = {
          undelivered: { name: 'undelivered', label: t('picker.group.undelivered') },
          delivered: { name: 'delivered', label: t('picker.group.delivered') },
        };
        return reply.value.payload.items.map(({ loadToken, age, nextTask, deliveredAt }) => ({
          id: loadToken,
          label: loadToken,
          detail: nextTask ? `${age}${DETAIL_SEPARATOR}${nextTask}` : age,
          group: deliveredAt == null ? groups.undelivered : groups.delivered,
        }));
      },
      onSelect(option, { sessionId }) {
        const actx = sessions.scope(sessionId);
        if (actx === undefined) throw new Error(t('picker.noSession'));
        conversation.input.for(actx).setDraft(`/${COMMAND} ${option.id}`);
      },
    },
  });
  // Registered after the decoration, so the unloading runs it first: a popup open on the command goes before the decoration that built it.
  child.effect(() => () => { commandUi.dismiss(COMMAND); }, 'session-watcher: /sw-load popup dismissal');
}
