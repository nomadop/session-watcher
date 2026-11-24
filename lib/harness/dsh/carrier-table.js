// lib/harness/dsh/carrier-table.js — the DSH wording table of the carrier and the source kinds whose sources carry evidence.
//
// The shared carrier modules (`lib/inner-seal/carrier.js`, `lib/inner-seal/state-block.js`, `lib/carried-evidence.js`) only
// join sentences; the DSH tool names and the sentences that depend on DSH behavior come from `CARRIER_TABLE`.
import { INNER_SEAL_KIND } from '../../inner-seal/carrier.js';
import { GIT_STATE_ITEM, isGitStateCommand } from '../../inner-seal/git-state.js';
import { LOAD_MESSAGE_KIND } from './load-message.js';

/**
 * Whether a message `source` carries evidence in the canonical structure `foldCarried` (`lib/carried-evidence.js`) reads: an inner-seal carrier's, or the read message of a load, whose `paths` state the lines its blocks show.
 */
export const carriesEvidence = source => source?.kind === INNER_SEAL_KIND || (source?.kind === LOAD_MESSAGE_KIND && Array.isArray(source.paths));

const isTodoItem = item => item !== null && typeof item === 'object' && typeof item.content === 'string' && typeof item.status === 'string';

/**
 * The items of a todo list `value` as `{ content, status }` in their order: a null and an empty list are the same empty state. A value that is neither is refused with an error, so no text stands in for it.
 */
function todoItemsOf(value) {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every(isTodoItem)) throw new Error('the todo list is neither null nor a list of items with a content text and a status text');
  return value.map(({ content, status }) => ({ content, status }));
}

// A list of entries each holding the text fields `fields`, copied to those fields alone; anything else is refused with an error.
function textEntriesOf(value, fields, what) {
  if (!Array.isArray(value) || !value.every(entry => entry !== null && typeof entry === 'object' && fields.every(field => typeof entry[field] === 'string'))) {
    throw new Error(`the ${what} is not a list of entries with ${fields.join(' and ')} texts`);
  }
  return value.map(entry => Object.fromEntries(fields.map(field => [field, entry[field]])));
}

const sameEntries = (fields, a, b) => a.length === b.length && a.every((entry, at) => fields.every(field => entry[field] === b[at][field]));

// The text of a subagent or job list, one `id — label` entry after another.
const entryList = entries => entries.map(({ id, label }) => `${id} — ${label}`).join('; ');

const AGENT_FIELDS = ['id', 'label'];
const TODO_FIELDS = ['content', 'status'];

// One state item: its line label is the sentence `label` makes of its tool's name.
const stateItem = ({ tool, label, ...rest }) => Object.freeze({ ...rest, tool, label: label(tool) });

function argumentsOf(call) {
  try {
    return JSON.parse(call.arguments);
  } catch {
    return undefined;
  }
}

/**
 * The DSH wording table the shared carrier modules render under. Each entry carries a required meaning and may be reworded
 * without changing it: `addresses` opens the carrier, stating that the lines below are work done in this session, that the seqs opening each line are the addresses of its events in this session's log, which the session history tools read, and that a line marked user is the user message's full text, word for word unless a marker says where it is cut; `imageReadTool` is the tool that reads a saved
 * image file back; `stateItems` are the items of the state block in the order the block lists them, each standing for
 * what its tool would show, or git state for which no tool is required. The host owns how it reads each value. `stateOperationOf` uses each item's tool or `matchesCall` to identify calls, and `operation` overrides the default read classification.
 */
export const CARRIER_TABLE = Object.freeze({
  addresses: `Work done in this session. Each line opens with the seq numbers of its events in this session's log, which the session history tools can read for detail a line leaves out. A line marked user: is that message's full text, word for word unless a marker says where it is cut.`,
  imageReadTool: 'read_image',
  stateItems: Object.freeze([
    stateItem({
      key: 'workingDirectory', tool: 'working_directory', label: tool => `Working directory, as ${tool} would show:`,
      operation: call => (typeof argumentsOf(call)?.cd === 'string' ? 'write' : 'read'),
      normalize: (value) => {
        if (typeof value !== 'string' || value === '') throw new Error('the working directory is not a path text');
        return value;
      },
      isEmpty: () => false,
      same: (a, b) => a === b,
      text: value => value,
    }),
    stateItem({
      key: 'subagents', tool: 'list_agents', label: tool => `Running subagents, as ${tool} would show:`,
      normalize: value => textEntriesOf(value, AGENT_FIELDS, 'subagent list'),
      isEmpty: entries => entries.length === 0,
      same: (a, b) => sameEntries(AGENT_FIELDS, a, b),
      text: entryList,
    }),
    stateItem({
      key: 'jobs', tool: 'job_list', label: tool => `Running jobs, as ${tool} would show:`,
      normalize: value => textEntriesOf(value, AGENT_FIELDS, 'job list'),
      isEmpty: entries => entries.length === 0,
      same: (a, b) => sameEntries(AGENT_FIELDS, a, b),
      text: entryList,
    }),
    stateItem({
      key: 'todos', tool: 'todo_write', operation: 'write', label: tool => `Todo list, as ${tool} last left it:`,
      normalize: todoItemsOf,
      isEmpty: items => items.length === 0,
      same: (a, b) => sameEntries(TODO_FIELDS, a, b),
      text: items => JSON.stringify(items),
    }),
    Object.freeze({ ...GIT_STATE_ITEM, matchesCall: call => call.name === 'bash' && isGitStateCommand(argumentsOf(call)?.command) }),
  ]),
});

/** The operation a dispatched call performs on a carrier state item, or undefined for unrelated calls. */
export function stateOperationOf(call) {
  if (typeof call?.name !== 'string') return undefined;
  const item = CARRIER_TABLE.stateItems.find(item => item.matchesCall?.(call) ?? item.tool === call.name);
  if (item === undefined) return undefined;
  return typeof item.operation === 'function' ? item.operation(call) : item.operation ?? 'read';
}
