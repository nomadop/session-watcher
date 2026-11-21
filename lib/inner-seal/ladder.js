// lib/inner-seal/ladder.js — the ladder a seal asks its summary again on: the two failures a new request may cure, the selection each request takes and the bound on the requests.

/** The `failure` of a summary whose reply is a tool call or stopped text that is not the notes object: a failure a new request on the same route may cure. */
export const FORMAT_FAILURE = 'format';
/** The `failure` of a summary whose stream a content filter cut off. */
export const FILTER_FAILURE = 'filtered';
/** The most summary requests one seal makes that no content filter caused: the first, and each further one a `FORMAT_FAILURE` earns. A request that opens a new rung of the ladder (`SUMMARY_FILTER_RETRIES`, the fallback) is not counted against it. */
export const SUMMARY_MAX_REQUESTS = 3;
/** The requests a seal repeats on the session's own selection after a content filter cut its summary off, before it turns to the fallback. */
export const SUMMARY_FILTER_RETRIES = 1;

/**
 * The ladder of one seal's summary requests. Its rungs are `selection`, the session's own, `SUMMARY_FILTER_RETRIES`
 * repeats of it, then `fallback`, the settings' backup route, where it is not null; `current()` is the selection the
 * request at hand takes. `next(failure)` answers whether a failed request is asked again, and moves the ladder for it:
 * a `FORMAT_FAILURE` is asked again on the same rung while the requests it counts, the first included, are under
 * `SUMMARY_MAX_REQUESTS`; a `FILTER_FAILURE` moves down a rung while one is left, the format count untouched; any other
 * failure is not asked again. Whether the failed request's call was recorded and the turn is not cancelled is the
 * caller's to decide before it asks.
 * @param {{ selection: object, fallback: (object|null) }} routes
 * @returns {{ current: () => object, next: (failure: (string|undefined)) => boolean }}
 */
export function createRetryLadder({ selection, fallback }) {
  const rungs = [selection, ...Array(SUMMARY_FILTER_RETRIES).fill(selection), ...(fallback === null ? [] : [fallback])];
  let rung = 0;
  let requests = 1;
  return {
    current: () => rungs[rung],
    next(failure) {
      if (failure === FORMAT_FAILURE && requests < SUMMARY_MAX_REQUESTS) {
        requests += 1;
        return true;
      }
      if (failure === FILTER_FAILURE && rung < rungs.length - 1) {
        rung += 1;
        return true;
      }
      return false;
    },
  };
}
