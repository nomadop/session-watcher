// dsh/src/epoch-model-name.js — the `agent/pre-step` listener that has a step's model name ready while its Context Epoch has no measured call.
// It knows no DSH service: the host hands it whether the session's epoch model is still unfixed and `warm` of the model names.

// The wait ends with `signal`'s reason; the resolve it waited on goes on for whoever shares it. The signal is the run's, not the step's, so a wait that ends otherwise takes its listener off it.
function untilAborted(wait, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    wait.then(resolve).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * The listener for `agent/pre-step`.
 * After the other listeners answered (`next()`), an `enter` decision whose session `awaitsEpochModel` (its watcher is live and no call of the open epoch is measured, so the step's call fixes the Epoch Model) waits for `warm([modelSelection])`, the model the step captured, which fulfils or settles without a name. Any other answer, a `reject` included, and any other session state pass at once. The decision is the one `next()` answered.
 * A step with an Epoch Model already fixed, whatever model it takes, waits for nothing. An abort of `payload.signal` ends the wait by throwing its reason, and a resolve in flight is no one caller's to cancel.
 * @param {{ awaitsEpochModel: (sessionId: string) => boolean,
 *   warm: (pairs: { provider: string, model: string }[]) => Promise<unknown> }} services
 */
export function createEpochModelName({ awaitsEpochModel, warm }) {
  return async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const { agent, signal, modelSelection } = payload;
    if (awaitsEpochModel(agent.session.id)) await untilAborted(warm([modelSelection]), signal);
    return decision;
  };
}
