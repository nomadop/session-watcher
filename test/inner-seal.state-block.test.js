// The session state block: the `state` field a seal carries against the carriers before it, and the text that field renders
// to. The items are the harness's table, injected; the cases run over the DSH one.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { STATE_WORDING, carryState, renderState } from '../lib/inner-seal/state-block.js';
import { CARRIER_TABLE } from '../lib/harness/dsh/carrier-table.js';

const STATE_ITEMS = CARRIER_TABLE.stateItems;
const itemOf = key => STATE_ITEMS.find(item => item.key === key);
const toolOf = key => itemOf(key).tool;

describe('the state block\'s text', () => {
  const TODOS = { asOfSeq: 41, value: [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it\nand check the bundle', status: 'in_progress' }, { content: 'Announce', status: 'pending' }] };

  // The items a seal shows, each in its own line behind one heading with the cut.
  const W = STATE_WORDING;
  const AGENTS = [{ id: 'agent-1', label: 'review the parser' }, { id: 'agent-2', label: 'port the tests; then the docs' }];
  const JOBS = [{ id: 'bash-1a2b', label: 'npm run watch' }];
  const STATE = {
    asOfSeq: 41,
    items: {
      workingDirectory: { value: '/repo/app' },
      subagents: { value: AGENTS },
      jobs: { value: JOBS },
      todos: { value: TODOS.value },
    },
  };
  const lineOf = (key, tail) => `${itemOf(key).label} ${tail}`;
  const stateText = (asOfSeq, lines) => [W.heading(asOfSeq), ...lines].join('\n');
  const stateOf = state => renderState(state, STATE_ITEMS);

  test('a state renders its shown items under one heading with the session seq of the cut: each item one line in the fixed order working directory, running subagents, running jobs, todo list, whatever order the source holds them in', () => {
    const lines = [
      lineOf('workingDirectory', '/repo/app'),
      lineOf('subagents', itemOf('subagents').text(AGENTS)),
      lineOf('jobs', itemOf('jobs').text(JOBS)),
      lineOf('todos', JSON.stringify(TODOS.value.map(({ content, status }) => ({ content, status })))),
    ];
    assert.equal(stateOf(STATE), stateText(41, lines));
    const reversed = { asOfSeq: 41, items: Object.fromEntries(Object.entries(STATE.items).reverse()) };
    assert.deepEqual(stateOf(reversed), stateOf(STATE), 'the order of the keys is no part of the source');
    const some = { asOfSeq: 8, items: { jobs: { value: JOBS }, workingDirectory: { value: '/x' } } };
    assert.equal(stateOf(some), stateText(8, [lineOf('workingDirectory', '/x'), lineOf('jobs', itemOf('jobs').text(JOBS))]), 'only the shown items have a line');
  });

  test('the git item opens on the line after its label and its text stands on lines of its own, last in the block; unchanged, it is one line like any other, and every other line is as it was', () => {
    const GIT = '## main...origin/main [ahead 1]\n M lib/a.js\n?? notes.md\n4f2a9c1 fix the thing';
    const label = itemOf('git').label;
    const withGit = git => stateOf({ ...STATE, items: { ...STATE.items, git } });
    assert.equal(label, label.trimEnd(), 'nothing trails the label');
    assert.equal(withGit({ value: GIT }), [stateOf(STATE), label, GIT].join('\n'));
    assert.equal(withGit({ value: GIT, unchanged: true }), [stateOf(STATE), `${label} ${W.unchanged}`].join('\n'));
    assert.deepEqual(STATE_ITEMS.map(({ key }) => key).at(-1), 'git', 'it stands after the todo list');
  });

  test('an unchanged item says so after its colon in place of its value, and an empty one says it is empty; the source still holds the value of each', () => {
    const state = {
      asOfSeq: 5,
      items: {
        workingDirectory: { value: '/repo', unchanged: true },
        subagents: { value: [] },
        jobs: { value: [] },
        todos: { value: [{ content: 'Same', status: 'pending' }], unchanged: true },
      },
    };
    assert.equal(stateOf(state), stateText(5, [
      lineOf('workingDirectory', W.unchanged), lineOf('subagents', W.empty), lineOf('jobs', W.empty), lineOf('todos', W.unchanged),
    ]));
  });

  test('values that are not what their item holds render nothing, whichever item holds them: no substitute text stands for them', () => {
    const of = (key, value, ...cut) => () => stateOf({ asOfSeq: cut.length === 0 ? 3 : cut[0], items: { [key]: { value } } });
    const refused = [
      ['a working directory that is no text', of('workingDirectory', 5)],
      ['a working directory that is empty text', of('workingDirectory', '')],
      ['subagents that are no list', of('subagents', 'agent-1')],
      ['a subagent with no label', of('subagents', [{ id: 'agent-1' }])],
      ['a job that is no object', of('jobs', [null])],
      ['a job whose id is no text', of('jobs', [{ id: 4, label: 'x' }])],
      ['todos that are no list', of('todos', { content: 'x', status: 'pending' })],
      ['a git state that is no text', of('git', ['## main'])],
      ['a git state that is empty text', of('git', '')],
      ['a todo with no status', of('todos', [{ content: 'x' }])],
      ['a value that is absent', of('jobs', undefined)],
      ['a cut that is no seq', of('jobs', JOBS, '3')],
      ['a cut that names none', of('jobs', JOBS, undefined)],
    ];
    for (const [why, render] of refused) assert.throws(render, Error, why);
    assert.doesNotThrow(of('jobs', JOBS, -1), 'an empty log\'s cut is a cut');
    assert.doesNotThrow(of('todos', null), 'a null todo list is the empty list');
  });

  test('an unknown item key in a source has no line and does not fail the render', () => {
    const state = { asOfSeq: 6, items: { jobs: { value: JOBS }, later: { value: 'x' } } };
    assert.equal(stateOf(state), stateText(6, [lineOf('jobs', itemOf('jobs').text(JOBS))]));
  });
});

describe('the state a seal carries', () => {
  const TODO_A = [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }];
  const TODO_B = [{ content: 'Review it', status: 'pending' }];
  const MULTILINE = [{ content: 'Check the bundle\nthen the build', status: 'pending' }];
  const AGENT_A = [{ id: 'agent-1', label: 'review' }];
  const AGENT_B = [{ id: 'agent-1', label: 'review' }, { id: 'agent-2', label: 'port' }];
  const JOB_A = [{ id: 'bash-1', label: 'watch' }];
  const JOB_B = [{ id: 'bash-1', label: 'watch' }, { id: 'bash-2', label: 'serve' }];
  const ALL_TOOLS = new Set(STATE_ITEMS.map(({ tool }) => tool));

  // A carrier source an earlier seal left, showing `items` as `{ key: { value, unchanged? } }`, at the cut `asOfSeq`.
  const showing = (items, asOfSeq = 3) => ({ kind: 'test-carrier', v: 1, slots: [], paths: [], state: { asOfSeq, items } });
  // The items read as `{ key: value }`, each a read that answers its value.
  const readOf = (values, asOfSeq) => ({ asOfSeq, items: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, () => value])) });
  const carry = (values, earlier = [], options = {}) => {
    const { tools = ALL_TOOLS } = options;
    const failures = [];
    const state = carryState(readOf(values, Object.hasOwn(options, 'asOfSeq') ? options.asOfSeq : 9), { stateItems: STATE_ITEMS, tools, earlier, failed: (item, error) => failures.push([item.key, error]) });
    return { state, failures };
  };

  // Per item: a value, a different value, the empty value, and a state that is the item's value with the same content spelled again.
  const ITEMS = {
    workingDirectory: { first: '/repo', other: '/repo/sub', again: '/repo', empty: undefined },
    subagents: { first: AGENT_A, other: AGENT_B, again: AGENT_A.map(entry => ({ ...entry })), empty: [] },
    jobs: { first: JOB_A, other: JOB_B, again: JOB_A.map(entry => ({ ...entry })), empty: [] },
    todos: { first: TODO_A, other: TODO_B, again: TODO_A.map(entry => ({ ...entry })), empty: [] },
    git: { first: '## main\n4f2a9c1 first', other: '## main\n M a.js\n4f2a9c1 first', again: ['## main', '4f2a9c1 first'].join('\n'), empty: undefined },
  };

  test('each item follows the value the nearest retained carrier showing it left: never shown and empty it is left out, never shown and not empty it is shown whole, the same as shown it is shown as unchanged with its value unless it is empty, another it is shown whole, and an empty one is shown as empty whether or not it is the one last shown', () => {
    for (const [key, { first, other, again, empty }] of Object.entries(ITEMS)) {
      const alone = (value, earlier = []) => carry({ [key]: value }, earlier).state?.items[key];
      assert.deepEqual(alone(first), { value: first }, `${key}: never shown, not empty`);
      assert.deepEqual(alone(first, [showing({ [key]: { value: first } })]), { value: first, unchanged: true }, `${key}: the same as shown`);
      assert.deepEqual(alone(again, [showing({ [key]: { value: first } })]), { value: again, unchanged: true }, `${key}: equal content, not the same object`);
      assert.deepEqual(alone(other, [showing({ [key]: { value: first } })]), { value: other }, `${key}: another value`);
      assert.deepEqual(alone(first, [showing({ [key]: { value: first, unchanged: true } })]), { value: first, unchanged: true }, `${key}: a carrier that showed it as unchanged still shows it`);
      if (empty === undefined) continue;
      assert.equal(alone(empty), undefined, `${key}: never shown, empty`);
      assert.deepEqual(alone(empty, [showing({ [key]: { value: first } })]), { value: empty }, `${key}: empty after a value`);
      assert.deepEqual(alone(empty, [showing({ [key]: { value: empty } })]), { value: empty }, `${key}: empty again after an empty shown, still empty and not unchanged`);
      assert.deepEqual(alone(first, [showing({ [key]: { value: empty } })]), { value: first }, `${key}: a value after an empty shown`);
    }
  });

  test('the nearest retained carrier that shows an item decides, whatever carriers that show other items or none stand between: A, B, A is shown again, and an earlier source that holds no state, as a load\'s read message, or one without the item is no anchor', () => {
    const todos = value => showing({ todos: { value } });
    const other = showing({ jobs: { value: JOB_A } });
    const load = { kind: 'session-watcher-load', paths: [] };
    const rows = [
      ['A then carriers showing other items', [todos(TODO_A), other, showing({ workingDirectory: { value: '/x' } })], TODO_A, true],
      ['A, B, then A again', [todos(TODO_A), todos(TODO_B)], TODO_A, false],
      ['B, A, then none, then A', [todos(TODO_B), todos(TODO_A), other], TODO_A, true],
      ['A then the empty state, then A again', [todos(TODO_A), todos([])], TODO_A, false],
      ['a source that is not a carrier', [load], TODO_A, false],
      ['a multiline content the same', [todos(MULTILINE)], MULTILINE.map(entry => ({ ...entry })), true],
      ['a multiline content with its break read as a space', [todos(MULTILINE)], [{ content: 'Check the bundle then the build', status: 'pending' }], false],
      ['the same items in another order', [todos(TODO_A)], [...TODO_A].reverse(), false],
      ['one status changed', [todos(TODO_A)], TODO_A.map((entry, at) => (at === 0 ? { ...entry, status: 'pending' } : entry)), false],
    ];
    for (const [why, earlier, current, unchanged] of rows) {
      const { state } = carry({ todos: current }, earlier);
      assert.equal(state?.items.todos.unchanged === true, unchanged, why);
    }
  });

  test('the block is the shown items under one cut, in the fixed order of the items, and no block where no item is shown', () => {
    const { state } = carry({ git: '## main\n4f2a9c1 first', todos: TODO_A, jobs: JOB_A, workingDirectory: '/repo', subagents: AGENT_A }, [], { asOfSeq: 41 });
    assert.equal(state.asOfSeq, 41);
    assert.deepEqual(Object.keys(state.items), STATE_ITEMS.map(({ key }) => key));
    assert.equal(carry({ todos: [], jobs: [], subagents: [] }).state, null, 'every item empty and never shown');
    assert.equal(carry({}).state, null, 'no item read at all');
    const settled = [showing({ todos: { value: [] }, jobs: { value: [] } })];
    assert.deepEqual(Object.keys(carry({ todos: [], jobs: [] }, settled).state.items), ['jobs', 'todos'], 'an empty item that was shown is shown again, not left out');
  });

  test('an item whose tool the session does not list is not read and not shown, and an item the host has no read for is neither, with no failure for either', () => {
    const reads = [];
    const read = { asOfSeq: 4, items: Object.fromEntries(STATE_ITEMS.filter(({ tool }) => tool !== undefined).map(({ key }) => [key, () => { reads.push(key); return key === 'workingDirectory' ? '/repo' : [{ id: 'x', label: 'y', content: 'z', status: 'pending' }]; }])) };
    const failures = [];
    const state = carryState(read, { stateItems: STATE_ITEMS, tools: new Set([toolOf('jobs'), toolOf('todos'), 'read']), earlier: [], failed: (...args) => failures.push(args) });
    assert.deepEqual(Object.keys(state.items), ['jobs', 'todos']);
    assert.deepEqual(reads, ['jobs', 'todos'], 'only the items the session can read again are read');
    const { items: { jobs, ...rest } } = read;
    const without = carryState({ asOfSeq: 4, items: rest }, { stateItems: STATE_ITEMS, tools: ALL_TOOLS, earlier: [], failed: () => failures.push('failed') });
    assert.deepEqual(Object.keys(without.items), ['workingDirectory', 'subagents', 'todos']);
    assert.deepEqual(failures, []);
    assert.equal(carryState(read, { stateItems: STATE_ITEMS, tools: new Set(), earlier: [], failed: () => failures.push('failed') }), null, 'a session that lists none of them');
  });

  test('an item that stands for no tool is not asked of the session\'s tools: it is shown whatever the session lists, and with no read from the host it is not shown, with no failure', () => {
    const GIT = '## main\n4f2a9c1 first';
    const failures = [];
    const options = { stateItems: STATE_ITEMS, tools: new Set(), earlier: [], failed: (...args) => failures.push(args) };
    assert.deepEqual(carryState(readOf({ git: GIT }, 4), options), { asOfSeq: 4, items: { git: { value: GIT } } }, 'no tool listed');
    assert.equal(carryState(readOf({}, 4), options), null, 'no read for it');
    assert.equal(carryState({ asOfSeq: 4, items: { git: undefined } }, options), null, 'a host that has none');
    assert.deepEqual(failures, []);
  });

  test('an item whose read throws or whose value is not what the item holds is left out and reported once with the item and the error, while every other item stands', () => {
    const boom = new Error('the jobs registry could not be read');
    const read = {
      asOfSeq: 12,
      items: {
        workingDirectory: () => '/repo',
        subagents: () => 'not a list',
        jobs: () => { throw boom; },
        todos: () => TODO_A,
      },
    };
    const failures = [];
    const state = carryState(read, { stateItems: STATE_ITEMS, tools: ALL_TOOLS, earlier: [], failed: (item, error) => failures.push([item.key, error]) });
    assert.deepEqual(Object.keys(state.items), ['workingDirectory', 'todos']);
    assert.deepEqual(failures.map(([key]) => key), ['subagents', 'jobs'], 'one report per failing item, in the items\' order');
    assert.equal(failures[1][1], boom);
    assert.ok(failures[0][1] instanceof Error);
    const allFailing = carryState({ asOfSeq: 1, items: { jobs: () => { throw boom; } } }, { stateItems: STATE_ITEMS, tools: ALL_TOOLS, earlier: [], failed: () => {} });
    assert.equal(allFailing, null, 'no item shown, no block');
    const badEarlier = carry({ todos: TODO_A }, [showing({ todos: { value: 'later' } })]);
    assert.equal(badEarlier.state, null, 'an earlier source that holds no list for the item fails the item, not the block');
    assert.deepEqual(badEarlier.failures.map(([key]) => key), ['todos']);
  });

  test('a cut that is no session seq is refused with an error, and the values handed out are copied: changing them later leaves the carried state as it was', () => {
    assert.throws(() => carry({ jobs: JOB_A }, [], { asOfSeq: undefined }), Error);
    assert.throws(() => carry({ jobs: JOB_A }, [], { asOfSeq: '3' }), Error);
    const live = { agents: AGENT_A.map(entry => ({ ...entry })), todos: TODO_A.map(entry => ({ ...entry })) };
    const { state } = carry({ subagents: live.agents, todos: live.todos });
    live.agents[0].label = 'rewritten';
    live.agents.push({ id: 'late', label: 'late' });
    live.todos[0].status = 'pending';
    assert.deepEqual(state.items.subagents.value, AGENT_A);
    assert.deepEqual(state.items.todos.value, TODO_A);
  });

  test('the carried state renders from the source alone and the carriers chain: a state carried against the first one renders its unchanged item as unchanged, its changed one whole', () => {
    const first = { kind: 'test-carrier', v: 1, slots: [{ seqs: [3], text: 'Done.' }], paths: [], state: carry({ workingDirectory: '/repo', todos: TODO_A }, [], { asOfSeq: 7 }).state };
    const second = { ...first, state: carry({ workingDirectory: '/repo', todos: TODO_B }, [first], { asOfSeq: 20 }).state };
    const text = source => renderState(source.state, STATE_ITEMS);
    assert.ok(text(first).includes(STATE_WORDING.heading(7)));
    assert.ok(text(second).includes(STATE_WORDING.heading(20)));
    assert.ok(text(second).includes(`${itemOf('workingDirectory').label} ${STATE_WORDING.unchanged}`));
    assert.ok(text(second).includes(JSON.stringify(TODO_B)) && !text(second).includes(`${itemOf('todos').label} ${STATE_WORDING.unchanged}`));
    assert.deepEqual(JSON.parse(JSON.stringify(second)), second, 'the source is plain JSON');
  });
});

test('the items are the injected table\'s alone: a table of one item is read, compared and rendered through that item\'s own tool, shape and label', () => {
  const MODE = Object.freeze({
    key: 'mode', tool: 'mode_tool', label: 'Mode, as mode_tool would show:',
    normalize: (value) => { if (typeof value !== 'string') throw new Error('no mode'); return value; },
    isEmpty: value => value === '', same: (a, b) => a === b, text: value => `<${value}>`,
  });
  const read = value => ({ asOfSeq: 5, items: { mode: () => value, workingDirectory: () => '/repo' } });
  const options = earlier => ({ stateItems: [MODE], tools: new Set(['mode_tool', 'working_directory']), earlier, failed: () => assert.fail('no item fails') });
  const state = carryState(read('fast'), options([]));
  assert.deepEqual(state, { asOfSeq: 5, items: { mode: { value: 'fast' } } }, 'an item the table does not hold is not read');
  assert.equal(renderState(state, [MODE]), `${STATE_WORDING.heading(5)}\nMode, as mode_tool would show: <fast>`);
  const again = carryState(read('fast'), options([{ state }]));
  assert.equal(renderState(again, [MODE]), `${STATE_WORDING.heading(5)}\nMode, as mode_tool would show: ${STATE_WORDING.unchanged}`);
  assert.equal(renderState(carryState(read(''), options([{ state }])), [MODE]), `${STATE_WORDING.heading(5)}\nMode, as mode_tool would show: ${STATE_WORDING.empty}`);
});
