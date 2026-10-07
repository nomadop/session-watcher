// dsh/src/client/context.js — the element ctx a DSH tab instance hands its elements, `request` answered over the session-bound RPC call.

/** The dashboard request each element sends, as `${method} ${path}`, to the RPC endpoint that answers it. */
const ENDPOINTS = {
  'GET /api/pricing': 'pricing',
  'POST /api/pricing': 'pricing/save',
  'DELETE /api/pricing': 'pricing/delete',
  'POST /api/user-overrides': 'user-overrides',
  'POST /api/preview': 'preview',
  'GET /api/turn/browse': 'turn/browse',
};

/** The HTTP status of each failure code: `server.js`'s status for its route codes, and 404 for `rpc.js`'s `unknown_endpoint`. */
const FAILURE_STATUS = { invalid_body: 400, invalid_input: 400, no_model: 409, unknown_endpoint: 404 };

const response = (ok, status, body) => ({ ok, status, json: async () => body });

/**
 * `request(path, init)` sends the parsed `init.body`, or an empty object, to the path's endpoint through `call`, which carries the session, and answers the Response shape the element reads:
 * a `live` value is `200` with its payload; an `ok: false` envelope is the route's status with the route's `{ error, message }` body; a non-`live` state is `503` with the state as `error`.
 * A rejected call rejects.
 * `bus`, `charts` and `overlayRoot` belong to this instance alone; the shell adds `transport`.
 *
 * @param {{ call: (endpoint: string, payload: object) => Promise<object>, root: Element }} options
 */
export function createTabContext({ call, root }) {
  async function request(path, init = {}) {
    const method = init.method ?? 'GET';
    const envelope = await call(ENDPOINTS[`${method} ${path}`], init.body === undefined ? {} : JSON.parse(init.body));
    if (envelope.ok !== true) {
      const { code, message } = envelope.error;
      return response(false, FAILURE_STATUS[code], { error: code, message });
    }
    const { state, payload, diagnostic } = envelope.value;
    if (state !== 'live') return response(false, 503, { error: state, message: diagnostic?.message ?? state });
    return response(true, 200, payload);
  }

  return { request, bus: new EventTarget(), charts: { hero: null, history: null }, overlayRoot: root };
}
