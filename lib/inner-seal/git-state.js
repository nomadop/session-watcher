// lib/inner-seal/git-state.js — the git state item of the state block: the output of the two git commands a session would run to check where its working directory stands.
//
// It belongs to no harness: it knows the commands and the directory they run in, and no tool of any host.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const STATUS_COMMAND = ['status', '--short', '--branch'];
const LOG_COMMAND = ['log', '-1', '--oneline'];
const BRANCH_LINE_START = '## ';
// The repository's config is the session's own, and `core.fsmonitor` there names a program git would run for a status.
const GIT_SAFE_OPTIONS = ['-c', 'core.fsmonitor=false'];

/** Whether a shell command is a simple git status probe, optionally followed by the HEAD query of this state item. */
export function isGitStateCommand(command) {
  if (typeof command !== 'string') return false;
  const [status, head, ...rest] = command.trim().split(/[ \t]*&&[ \t]*/u);
  return rest.length === 0 && /^git[ \t]+status(?:[ \t]+--?[\w=-]+)*$/u.test(status)
    && (head === undefined || head.split(/[ \t]+/u).join(' ') === `git ${LOG_COMMAND.join(' ')}`);
}
// The command the notice of cut status lines points to.
const STATUS_LISTING = 'git status --short';

/** The most status lines the text shows, the branch line and the HEAD line apart. */
export const GIT_STATUS_LINE_LIMIT = 20;
/** How long each of the two commands may run before the read fails. */
export const GIT_READ_TIMEOUT_MS = 5_000;

// The lines of a command's output, the break that closes it no line of its own.
const linesOf = text => text.split('\n').filter((line, at, all) => line !== '' || at < all.length - 1);

// The one line that stands for the status lines the limit cut: how many are left and the command that lists them all.
const leftNotice = count => `… and ${count} more not shown; \`${STATUS_LISTING}\` lists them all`;

// The message that tells a directory that is no repository is read in git's own wording, which the user's language would change. A status that refreshes stale index entries rewrites the index under its lock, which a git add or commit of the session running beside the seal would find held, so the read leaves the index alone.
const GIT_ENV = { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

// A command's stdout. A git that exits non-zero answers `{ exit: stderr }` instead, which a caller may take as an answer; anything else that goes wrong, a spawn failure, a timeout and an abort included, is thrown.
async function runGit(args, { cwd, signal, timeoutMs }) {
  try {
    const { stdout } = await execFileAsync('git', [...GIT_SAFE_OPTIONS, ...args], { cwd, signal, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    return { stdout };
  } catch (error) {
    if (typeof error.code === 'number') return { exit: error.stderr };
    throw error;
  }
}

/**
 * The text of `git status --short --branch` followed by that of `git log -1 --oneline`, run in `cwd`, or null where `cwd` is no repository. The status lines past `GIT_STATUS_LINE_LIMIT` are replaced by one line that says how many are left. A repository with no commit yet reads as its status alone. A read that cannot finish, or whose output is not what the commands print, is thrown, and so is `signal` aborting.
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<string|null>}
 */
export async function readGitState({ cwd, signal, timeoutMs = GIT_READ_TIMEOUT_MS }) {
  // A directory that names none would run git in the host's own.
  if (typeof cwd !== 'string' || cwd === '') throw new Error('the git state has no working directory to be read in');
  const options = { cwd, signal, timeoutMs };
  const status = await runGit(STATUS_COMMAND, options);
  if ('exit' in status) {
    if (/not a git repository/i.test(status.exit)) return null;
    throw new Error(`git ${STATUS_COMMAND.join(' ')} failed: ${status.exit.trim()}`);
  }
  const [branch, ...entries] = linesOf(status.stdout);
  if (!branch?.startsWith(BRANCH_LINE_START)) throw new Error(`git ${STATUS_COMMAND.join(' ')} printed no branch line`);
  const log = await runGit(LOG_COMMAND, options);
  const heads = 'exit' in log ? [] : linesOf(log.stdout);
  if (heads.length > 1 || (heads.length === 1 && heads[0] === '')) throw new Error(`git ${LOG_COMMAND.join(' ')} did not print one line`);
  const left = entries.length - GIT_STATUS_LINE_LIMIT;
  return [branch, ...entries.slice(0, GIT_STATUS_LINE_LIMIT), ...(left > 0 ? [leftNotice(left)] : []), ...heads].join('\n');
}

/**
 * The state block item for the git state: its value is the text `readGitState` answers, shown under its label on lines of its own.
 */
export const GIT_STATE_ITEM = Object.freeze({
  key: 'git',
  label: `Git, as \`git ${STATUS_COMMAND.join(' ')} && git ${LOG_COMMAND.join(' ')}\` would show:`,
  multiline: true,
  normalize: (value) => {
    if (typeof value !== 'string' || value === '') throw new Error('the git state is not a text');
    return value;
  },
  isEmpty: () => false,
  same: (a, b) => a === b,
  text: value => value,
});
