// dsh/src/observed-read.js — a read of the Working Tree that DSH's edit guard counts as the agent having read the file, and the same read recording nothing.
// It knows no Cordis: the `fs` service, the event emitter and the tree reach it by parameter.
import { readTreeWindows } from '../../lib/working-tree-text.js';

// The execution world's target of `key` and the path the `read` tool prints for it, null where the backend maps no such key; a `resolve` that throws throws.
async function targetOf(fs, key, signal) {
  const mapped = fs.processPathFromHostPath(key);
  if (mapped === undefined) return null;
  const target = await fs.resolve(mapped, { signal });
  return { target, displayPath: fs.processPath(target) };
}

/**
 * Read the lines `ranges` ask for of `key`, a Working Tree key, and record the observation the `read` tool would have recorded.
 * `fs.processPathFromHostPath` maps the key into the execution world, `fs.resolve` and `fs.stat` (both with `signal`) state the version the file has before the tree is read, and a read that comes out `readable` then emits `fs/observed` with `{ kind: 'present', version }` and `{ agent }` as its actor.
 * The version is taken before the read: a file rewritten in between fails a later `edit` as stale, where a version taken after it would let the edit overwrite lines the agent never saw.
 * A key the backend does not map, a `resolve` or `stat` that throws or finds nothing, and an unreadable file record no observation; the read is answered all the same, as the tree answers it.
 * `displayPath` is the path the `read` tool prints for the target (`fs.processPath`), or `key` when `fs` resolved none.
 *
 * @returns {Promise<{ read: ReturnType<typeof readTreeWindows>, displayPath: string }>}
 */
export async function readObserved({ fs, emit, agent, tree, key, ranges, fileBytes, signal }) {
  let displayPath = key;
  let observed = null;
  try {
    const found = await targetOf(fs, key, signal);
    if (found !== null) {
      displayPath = found.displayPath;
      const info = await fs.stat(found.target, signal);
      if (info !== undefined) observed = { target: found.target, version: info.version };
    }
  } catch {
    // The execution world cannot state a version for this path, so the text is read unobserved.
  }
  const read = readTreeWindows(tree, key, ranges, { fileBytes });
  if (read.status === 'readable' && observed !== null) {
    emit('fs/observed', observed.target, { kind: 'present', version: observed.version }, { agent });
  }
  return { read, displayPath };
}

/**
 * The read `readObserved` answers for the same arguments, its `read` and `displayPath`, with no version stated and no observation recorded: a key the backend does not map or a `resolve` that throws is displayed as `key`.
 *
 * @returns {Promise<{ read: ReturnType<typeof readTreeWindows>, displayPath: string }>}
 */
export async function readUnobserved({ fs, tree, key, ranges, fileBytes, signal }) {
  let displayPath = key;
  try {
    displayPath = (await targetOf(fs, key, signal))?.displayPath ?? key;
  } catch {
    // The execution world names no path for this key, so the key is shown.
  }
  return { read: readTreeWindows(tree, key, ranges, { fileBytes }), displayPath };
}
