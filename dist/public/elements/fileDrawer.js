// public/elements/fileDrawer.js — the drawer that shows the lines the session holds of one file.
//
// The bucket panel opens it for a file row. One POST /api/bucket/file per open answers the lines the watcher holds of
// that path, read from the working tree at that moment; the drawer is that snapshot and does not follow the polls.
// The lines are drawn by `public/lib/fileRows.js`, the module the DSH tab's file pages draw theirs with. Its words are
// English and its own: the DSH tab's dictionary does not reach the dashboard.
import { domH } from '../lib/domH.js';
import { createDrawerShell } from '../lib/drawerShell.js';
import { bodyRowsOf, fileRows } from '../lib/fileRows.js';

const FILE_URL = '/api/bucket/file';

const REASON_WORDS = new Map([
  ['missing', 'Missing'], ['not-file', 'Not a file'], ['too-large', 'Too large'], ['binary', 'Binary'], ['unreadable', 'Cannot be read'],
]);

const notice = text => ({ kind: 'notice', text });
const LOADING = notice('Loading…');
const UNAVAILABLE = notice('This file is unavailable right now. Close and reopen the drawer to retry.');
const NOT_HELD = notice('This path is no longer held in the current context.');
const NO_LINES = notice('No lines of this file are held in the current context.');

/**
 * What the drawer shows for the parsed `body` of the answer of the file endpoint (null where there was none):
 * `{ kind: 'rows', held, total, rows }` for a file with held lines, `rows` being `bodyRowsOf` of them with a gap row for each stretch not held,
 * else `{ kind: 'notice', text }`: the file cannot be read (its reason in words, a reason with no word as it is), the host says it no longer holds the path (`not_held`),
 * the file holds no line, or the answer is none of these. The status does not decide: a 404 of another origin, such as a server without the endpoint, is none of these.
 */
export function fileViewOf(body) {
  if (body === null || typeof body !== 'object') return UNAVAILABLE;
  if (body.error === 'not_held') return NOT_HELD;
  if (typeof body.reason === 'string') return notice(`Unreadable: ${REASON_WORDS.get(body.reason) ?? body.reason}`);
  const { total, runs } = body;
  if (!Number.isFinite(total) || !Array.isArray(runs)) return UNAVAILABLE;
  const held = runs.reduce((sum, run) => sum + run.lines.length, 0);
  if (held === 0) return NO_LINES;
  return { kind: 'rows', held, total, rows: bodyRowsOf({ skill: false, total, runs, withdrawn: [] }) };
}

const WORDS = { gap: range => `⋯ Lines ${range} not loaded` };

/**
 * The file drawer over the page's `ctx`: `request` asks for a file's lines and `overlayRoot` holds the drawer.
 * `open(path, returnFocus)` shows `path` while its lines are asked for; the answer of an earlier open that arrives late is dropped.
 * `returnFocus` is the element, or a function that finds it when the drawer closes, which gets the focus back.
 * The wrapping of the lines is the drawer's own state and stays as it was set.
 */
export function createFileDrawer(ctx) {
  const shell = createDrawerShell({ overlayRoot: ctx.overlayRoot, title: 'File', closeLabel: 'Close file', className: 'sw-filedrawer' });
  let wrap = true;
  let view = LOADING;
  let latest = 0;

  const heldEl = domH('span', { className: 'sw-filedrawer-held' });
  const wrapBtn = domH('button', { className: 'sw-filedrawer-wrap', type: 'button', 'aria-pressed': 'true' }, 'Wrap lines');
  shell.head.appendChild(domH('div', { className: 'sw-filedrawer-meta' }, heldEl, wrapBtn));

  function paint() {
    shell.body.textContent = '';
    wrapBtn.setAttribute('aria-pressed', String(wrap));
    if (view.kind === 'notice') {
      heldEl.textContent = '';
      shell.body.appendChild(domH('div', { className: 'sw-filedrawer-notice' }, view.text));
      return;
    }
    heldEl.textContent = `Holds ${view.held} of ${view.total} lines`;
    shell.body.appendChild(domH('div', { className: 'sw-filedrawer-rows' }, fileRows(domH, view.rows, WORDS, wrap)));
    shell.body.appendChild(domH('div', { className: 'sw-filedrawer-foot' }, 'Line text is read from the disk now, so it can differ from what the session saw.'));
  }

  async function answerOf(path) {
    try {
      const res = await ctx.request(FILE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
      return fileViewOf(await res.json());
    } catch {
      // An answer that did not arrive, did not parse or has the shape of none the host sends is the one unavailable notice.
      return UNAVAILABLE;
    }
  }

  wrapBtn.addEventListener('click', () => {
    wrap = !wrap;
    paint();
  });

  return {
    async open(path, returnFocus) {
      const mine = ++latest;
      shell.setTitle(path);
      view = LOADING;
      paint();
      shell.open({ returnFocus });
      const answer = await answerOf(path);
      if (mine !== latest) return;
      view = answer;
      paint();
    },
    destroy() {
      shell.destroy();
    },
  };
}
