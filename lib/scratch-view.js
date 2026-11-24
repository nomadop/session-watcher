// lib/scratch-view.js — a read-only view of the scratch a live measurement Projection keeps (`lib/tool-evidence.js`): the Projection hands its epoch's scratch to the interpreter with every call, so wrapping the two interpreter functions the Projection is built with is the one place that holds the Map without the Projection or the watcher exposing it.
// The view takes no part in the interpretation: each wrapper only notes the Map and calls through, and a Projection that is built again, or an epoch that begins, hands the next call a new Map, which the next call replaces it by.

/**
 * @returns {{ observing: (interpreters: { interpretToolUse: function, completeToolResult: function }) => { interpretToolUse: function, completeToolResult: function }, read: () => (Map<string, Map<number, object>>|null) }}
 *   `observing` the same two functions with the view noting each call's scratch; `read` the scratch the latest call was handed, null before the first.
 */
export function createScratchView() {
  let scratch = null;
  const note = (options) => { scratch = options?.scratch ?? scratch; };
  return {
    observing: ({ interpretToolUse, completeToolResult }) => ({
      interpretToolUse: (observation, context, options) => {
        note(options);
        return interpretToolUse(observation, context, options);
      },
      completeToolResult: (pending, observation, context, options) => {
        note(options);
        return completeToolResult(pending, observation, context, options);
      },
    }),
    read: () => scratch,
  };
}
