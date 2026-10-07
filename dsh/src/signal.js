// dsh/src/signal.js — the host's signal hub: the events route that holds one stream per open page and the `{ sessionId }` frame written on each of them whenever a session changes.
// It knows only streams and session ids; Connection admits the route's requests before the hub sees them.

const EVENTS_PATH = '/api/session-watcher.events';
const encoder = new TextEncoder();
// Connection's bridge sends the response headers with the first body write, so this frame is what lets a client see the stream open.
const OPEN_FRAME = encoder.encode(': open\n\n');

/**
 * The signal hub.
 * `route()` is the Connection Fetch route whose every request opens one stream of `text/event-stream`, its first chunk a comment frame.
 * `publish(sessionId)` writes `data: {"sessionId": …}` on every open stream and never throws.
 * A stream ends when its request's signal aborts or `closeAll` runs, either of which closes it, and when its reader cancels it; an ended stream hears no later publish.
 * `closeAll()` ends every open stream, and a stream fetched afterwards is live.
 *
 * @returns {{ route: () => { path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> },
 *   publish: (sessionId: string) => void, closeAll: () => void }}
 */
export function createSignalHub() {
  const streams = new Set();
  let lifetime = new AbortController();

  async function fetch(request) {
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    let stream;
    const body = new ReadableStream({
      start(controller) {
        let ended = false;
        // One ending for every path; only the abort closes the controller, because closing a cancelled stream throws, and thrown inside the abort listener it would reach `uncaughtException` and end the DSH host.
        // Only this ending's close and a reader's cancel, which runs this ending before it returns, take a stream out of the readable state, and nothing errors the controller, so a `write` to a stream in the set never throws.
        const end = ({ close }) => {
          if (ended) return;
          ended = true;
          signal.removeEventListener('abort', onAbort);
          streams.delete(stream);
          if (close) controller.close();
        };
        const onAbort = () => end({ close: true });
        stream = {
          // `request.signal` follows the carrier's disconnect only while the Request is reachable, and the bridge drops it once `fetch` returns.
          request,
          write(chunk) { controller.enqueue(chunk); },
          cancel: () => end({ close: false }),
        };
        controller.enqueue(OPEN_FRAME);
        streams.add(stream);
        signal.addEventListener('abort', onAbort, { once: true });
      },
      cancel() { stream.cancel(); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }

  function publish(sessionId) {
    const frame = encoder.encode(`data: ${JSON.stringify({ sessionId })}\n\n`);
    for (const stream of streams) stream.write(frame);
  }

  function closeAll() {
    lifetime.abort();
    streams.clear();
    lifetime = new AbortController();
  }

  return {
    route: () => ({ path: EVENTS_PATH, methods: ['GET'], requestBody: 'buffered', fetch }),
    publish,
    closeAll,
  };
}
