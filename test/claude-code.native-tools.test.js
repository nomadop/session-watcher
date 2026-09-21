import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import os from 'node:os';
import {
  interpretClaudeCodeToolUse,
  completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload,
  interpretClaudeCodeTaskNotification,
  classifyToolPair,
  redactCmd,
} from '../lib/harness/claude-code/native-tools.js';
import { redactCmd as redactCmdFrontend } from '../public/lib/redaction.js';
import { charsToTokens } from '../lib/token-estimate.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { TOOL_OVERHEAD } from '../lib/constants.js';

const MODEL = 'claude-opus-4-8';
const CLAUDE_CTP = modelPolicyFor(MODEL).ctp;

function makeContext({ sessionCwd = '/repo', transcriptDir = '/transcripts' } = {}) {
  return {
    path: nodePath,
    homedir: os.homedir,
    sessionCwd,
    transcriptDir,
    resolveModelPolicy: modelPolicyFor,
  };
}

function useObservation({ name, input = {}, cwd = null, toolUseId = 'tu1', messageId = 'cc:message:m1', model = MODEL }) {
  return {
    type: 'tool-use',
    messageId, model, cwd, toolUseId, name, input,
    sourceOrdinal: 1, sourceEntryId: 'a1', timestamp: 1000,
  };
}

function resultObservation({ toolUseId = 'tu1', content = '', isError = undefined } = {}) {
  return {
    type: 'tool-result',
    toolUseId, content, isError,
    resultMeta: { annotation: undefined },
    sourceOrdinal: 2, sourceEntryId: 'u1', timestamp: 2000,
  };
}

// One native tool use plus its result, through the two Interfaces the Projection calls in that order.
function pairThrough(use, result, context = makeContext(), completionContext = context) {
  const started = interpretClaudeCodeToolUse(use, context);
  const completed = started.pending
    ? completeClaudeCodeToolResult(started.pending, result, completionContext)
    : null;
  return { started, completed };
}

function runTool({ name, input, cwd, content = '', isError, context, completionContext }) {
  return pairThrough(
    useObservation({ name, input, cwd }),
    resultObservation({ content, isError }),
    context ?? makeContext(),
    completionContext,
  );
}

function onlyEffect(completed) {
  assert.equal(completed.effects.length, 1, 'exactly one effect');
  return completed.effects[0];
}

function onlyImpact(effect) {
  assert.equal(effect.impacts.length, 1, 'exactly one impact');
  return effect.impacts[0];
}

// The whole content of a resource arrives as `replace-fragments` keyed by SOURCE LINE, like every other
// fragment snapshot: one resource has one key space, so an observation that overlaps an earlier one
// overwrites it rather than accumulating beside it. The KIND is what marks it whole-content.
//
// Pinning the summed value keeps the kind assertion from passing vacuously on a mutation that named the right
// kind and priced nothing, and pinning the key space keeps a synthetic key from creeping back in. Keys are
// asserted UNIQUE because last-write-wins within one impact is what keeps a line whose own text begins with a
// line-number cue from reaching the Ledger's duplicate-key invariant.
function assertWholeContent(impact, ...pricedText) {
  assert.equal(impact.mutation.kind, 'replace-fragments');
  const { fragments } = impact.mutation;
  // ONE fragment per priced line. This is what catches a mutation that MERGED two lines into a single
  // fragment carrying their sum — the exact shape of the accumulate-instead-of-overwrite regression this
  // helper's key-space assertions exist for, which a summed total alone would not distinguish. Every caller
  // enumerates the trailing empty line where its fixture has one, so the counts line up on write-side
  // observations too.
  assert.equal(fragments.length, pricedText.length, 'one fragment per priced source line');
  assert.ok(fragments.every(fragment => typeof fragment.key === 'number'),
    'every fragment is keyed by its source line number');
  assert.equal(new Set(fragments.map(fragment => fragment.key)).size, fragments.length,
    'and each source line appears at most once');
  assert.equal(
    fragments.reduce((sum, fragment) => sum + fragment.tokens, 0),
    pricedText.reduce((sum, text) => sum + charsToTokens(text, CLAUDE_CTP), 0),
  );
}

const READ_FULL = '1\tconst a = 1;\n2\tconst b = 2;\n3\tmodule.exports = { a, b };\n';
const SERENA_OK = payload => JSON.stringify({ result: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const SERENA_ERROR = JSON.stringify({ result: 'Error executing tool: boom' });

// ─── Read ────────────────────────────────────────────────────────────────────

describe('Read', () => {
  test('a complete read replaces the whole content and archives one full-read path event', () => {
    const { started, completed } = runTool({ name: 'Read', input: { file_path: 'src/a.js' }, content: READ_FULL });
    assert.equal(started.pending.toolUseId, 'tu1');
    assert.equal(started.pending.issuingStepId, 'cc:message:m1');
    assert.deepEqual(started.pending.issuingPolicy.ctp, CLAUDE_CTP);
    assert.deepEqual(started.effects, []);
    assert.deepEqual(started.residuals, []);
    assert.deepEqual(started.telemetry.pathEvents, []);

    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 40);
    assert.ok(effect.spentTokens > 0);
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, '/repo/src/a.js');
    assertWholeContent(impact, '1\tconst a = 1;', '2\tconst b = 2;', '3\tmodule.exports = { a, b };');
    assert.deepEqual(completed.residuals, []);
    assert.equal(completed.skillContinuation, null);
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: '/repo/src/a.js', rawPath: 'src/a.js', toolType: 'Read', isFullRead: 1 },
    ]);
  });

  // A file whose OWN first line begins with a line-number cue: the parsed lines collide on one key. The Ledger
  // treats a duplicate fragment key inside one impact as an invariant failure, and an application invariant
  // failure is OWNER-FATAL — so without last-write-wins here, ordinary file content would kill the owner. The
  // baseline overwrote silently (`_setLine` was a plain `Map.set` per line), which is what is preserved.
  test('a read whose content repeats a line-number cue keys each source line once, last write winning', () => {
    const duplicated = '1\tconst a = 1;\n1\tconst shadowed = 2;\n2\tconst b = 3;\n';
    const { completed } = runTool({ name: 'Read', input: { file_path: 'src/dup.js' }, content: duplicated });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.mutation.kind, 'replace-fragments');
    const keys = impact.mutation.fragments.map(fragment => fragment.key);
    assert.deepEqual(keys, [1, 2], 'the repeated cue collapsed to one entry per source line');
    assert.equal(new Set(keys).size, keys.length, 'no duplicate reaches the Ledger invariant');
    // Last write wins: line 1 carries the SECOND occurrence's text, not the first and not their sum.
    const lineOne = impact.mutation.fragments.find(fragment => fragment.key === 1);
    assert.equal(lineOne.tokens, charsToTokens('1\tconst shadowed = 2;', CLAUDE_CTP));
  });

  test('an offset read merges number-keyed line fragments and is not a full read', () => {
    const { completed } = runTool({
      name: 'Read',
      input: { file_path: '/repo/src/a.js', offset: 5, limit: 2 },
      content: '5\tline five\n6\tline six\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [5, 6]);
    for (const fragment of impact.mutation.fragments) {
      assert.equal(typeof fragment.key, 'number', 'a line fragment key is a number, never its decimal text');
      assert.ok(Number.isFinite(fragment.key));
    }
    assert.equal(completed.telemetry.pathEvents[0].isFullRead, 0);
  });

  test('a truncated read degrades to line fragments', () => {
    const { completed } = runTool({
      name: 'Read',
      input: { file_path: '/repo/src/a.js' },
      content: READ_FULL + '\n(File content truncated; use offset to read more)',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.equal(completed.telemetry.pathEvents[0].isFullRead, 0);
  });

  test('a harness hint shorter than one line produces nothing', () => {
    const { completed } = runTool({ name: 'Read', input: { file_path: '/repo/src/a.js' }, content: 'file not found' });
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
    assert.deepEqual(completed.telemetry.pathEvents, []);
  });

  test('an errored read produces neither effect nor residual', () => {
    const { completed } = runTool({
      name: 'Read', input: { file_path: '/repo/src/a.js' },
      content: 'permission denied', isError: true,
    });
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
    assert.deepEqual(completed.telemetry.pathEvents, []);
  });

  test('a read without a file path correlates but can never be effective', () => {
    const { started, completed } = runTool({ name: 'Read', input: {}, content: READ_FULL });
    assert.ok(started.pending, 'a matched adapter correlates even when its target is unresolved');
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
    assert.deepEqual(completed.telemetry.pathEvents, []);
  });

  test('a target-resolution failure on a file tool correlates nothing', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: 7 } }),
      makeContext(),
    );
    assert.equal(started.pending, null);
  });
});

// ─── Write and Edit ──────────────────────────────────────────────────────────

describe('Write and Edit', () => {
  test('a write replaces the whole content under write access', () => {
    const { completed } = runTool({
      name: 'Write', input: { file_path: 'out.txt', content: 'alpha\nbeta\n' }, content: 'ok',
    });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'write');
    assert.equal(effect.overheadTokens, 90);
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, '/repo/out.txt');
    assertWholeContent(impact, '1\talpha', '2\tbeta', '3\t');
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: '/repo/out.txt', rawPath: 'out.txt', toolType: 'Write', isFullRead: null },
    ]);
  });

  test('an edit adjusts the resource total and charges no effect overhead', () => {
    const { completed } = runTool({
      name: 'Edit',
      input: { file_path: '/repo/src/a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      content: 'ok',
    });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'write');
    assert.equal(effect.overheadTokens, 0);
    assert.ok(effect.spentTokens > 0);
    const impact = onlyImpact(effect);
    assert.equal(impact.mutation.kind, 'adjust-total');
    assert.equal(typeof impact.mutation.deltaTokens, 'number');
    assert.ok(Number.isFinite(impact.mutation.deltaTokens));
    assert.equal(completed.telemetry.pathEvents[0].isFullRead, null);
  });

  test('a CJK swap of equal character count still moves the resource total', () => {
    const { completed } = runTool({
      name: 'Edit',
      input: { file_path: '/repo/src/a.js', old_string: 'a'.repeat(50), new_string: '好'.repeat(50) },
      content: 'ok',
    });
    assert.ok(onlyImpact(onlyEffect(completed)).mutation.deltaTokens > 0);
  });

  test('an edit whose delta is zero still produces an effect', () => {
    const { completed } = runTool({
      name: 'Edit',
      input: { file_path: '/repo/src/a.js', old_string: 'same', new_string: 'same' },
      content: 'ok',
    });
    assert.equal(onlyImpact(onlyEffect(completed)).mutation.deltaTokens, 0);
  });

  test('an adapter exception produces empty effects and residuals', () => {
    const { completed } = runTool({
      name: 'Edit',
      input: { file_path: '/repo/src/a.js', old_string: 'x', new_string: 7 },
      content: 'ok',
    });
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
    assert.deepEqual(completed.telemetry.pathEvents, []);
  });
});

// ─── Grep ────────────────────────────────────────────────────────────────────

describe('Grep', () => {
  test('a multi-file result becomes one effect with one impact per canonical file', () => {
    const { completed } = runTool({
      name: 'Grep', input: { pattern: 'hit' },
      content: 'src/a.js:10:first hit\nsrc/b.js:20:second hit\nsrc/a.js:11:third hit\n',
    });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 40, 'per-invocation framing is charged once for the whole result');
    assert.deepEqual(effect.impacts.map(i => i.resourceKey).sort(), ['/repo/src/a.js', '/repo/src/b.js']);
    const first = effect.impacts.find(i => i.resourceKey === '/repo/src/a.js');
    assert.equal(first.mutation.kind, 'merge-fragments');
    assert.deepEqual(first.mutation.fragments.map(f => f.key), [10, 11]);
    assert.deepEqual(completed.telemetry.pathEvents.map(e => ({ ...e })).sort((a, b) => a.path.localeCompare(b.path)), [
      { path: '/repo/src/a.js', rawPath: '/repo/src/a.js', toolType: 'Grep', isFullRead: 0 },
      { path: '/repo/src/b.js', rawPath: '/repo/src/b.js', toolType: 'Grep', isFullRead: 0 },
    ]);
  });

  test('an empty grep produces no effect, no residual, and no path event', () => {
    const { completed } = runTool({ name: 'Grep', input: { pattern: 'nope' }, content: 'No matches found' });
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
    assert.deepEqual(completed.telemetry.pathEvents, []);
  });
});

// ─── Bash ────────────────────────────────────────────────────────────────────

describe('Bash file reads', () => {
  test('cat replaces the whole content', () => {
    const { completed } = runTool({ name: 'Bash', input: { command: 'cat notes.txt' }, content: 'alpha\nbeta\n' });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 10);
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assertWholeContent(impact, 'alpha', 'beta', '');
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: '/repo/notes.txt', rawPath: '/repo/notes.txt', toolType: 'Bash', isFullRead: 1 },
    ]);
  });

  test('head merges positional line fragments', () => {
    const { completed } = runTool({ name: 'Bash', input: { command: 'head -2 notes.txt' }, content: 'alpha\nbeta\n' });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [1, 2, 3]);
    assert.equal(completed.telemetry.pathEvents[0].isFullRead, 0);
  });

  test('grep -n merges the line numbers its output carries', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'grep -n foo notes.txt' }, content: '3:foo bar\n7:foo baz\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [3, 7]);
  });

  test('sed -n keys a range read from its start line', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '12,14p' notes.txt" }, content: 'alpha\nbeta\ngamma',
    });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 10);
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [12, 13, 14]);
    assert.equal(
      impact.mutation.fragments.reduce((sum, f) => sum + f.tokens, 0),
      ['alpha', 'beta', 'gamma'].reduce((sum, text) => sum + charsToTokens(text, CLAUDE_CTP), 0),
    );
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: '/repo/notes.txt', rawPath: '/repo/notes.txt', toolType: 'Bash', isFullRead: 0 },
    ]);
  });

  test('sed -n with a single address keys that one line', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'sed -n 7p notes.txt' }, content: 'only',
    });
    assert.deepEqual(onlyImpact(onlyEffect(completed)).mutation.fragments.map(f => f.key), [7]);
  });

  test('a multi-segment sed spec keys each segment from its own address', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,2p;5,6p' notes.txt" }, content: 'l1\nl2\nl5\nl6\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [1, 2, 5, 6, 7]);
    assert.equal(
      impact.mutation.fragments.reduce((sum, f) => sum + f.tokens, 0),
      ['l1', 'l2', 'l5', 'l6'].reduce((sum, text) => sum + charsToTokens(text, CLAUDE_CTP), 0),
    );
  });

  test('a multi-segment spec is read in file order however the command orders it', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '9,10p;3,4p' notes.txt" }, content: 'three\nfour\nnine\nten',
    });
    assert.deepEqual(onlyImpact(onlyEffect(completed)).mutation.fragments.map(f => f.key), [3, 4, 9, 10]);
  });

  test('a multi-segment result narrower than its spec is refused, because nothing says which segment came up short', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,2p;5,6p' notes.txt" }, content: 'l1\nl2\nl5',
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
    assert.equal(completed.residuals[0].groupKey, 'sed');
  });

  test('a single range keeps the shipped tolerance for a result wider than its spec', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,2p' notes.txt" }, content: 'l1\nl2\nl3',
    });
    assert.deepEqual(onlyImpact(onlyEffect(completed)).mutation.fragments.map(f => f.key), [1, 2, 3]);
  });

  // Whichever end of the spec the open segment sits at, the content is one the closed segments alone would
  // not account for, so only the open end can decide the refusal.
  test('an open segment beside another is refused, because its own lines can make up the other\'s shortfall', () => {
    for (const command of ["sed -n '1,2p;40,$p' notes.txt", "sed -n '1,$p;40,50p' notes.txt"]) {
      const { completed } = runTool({ name: 'Bash', input: { command }, content: 'l1\nl2\nl40\nl41' });
      assert.deepEqual(completed.effects, [], command);
    }
  });

  // The overlap refusal sits ahead of the width guard, so the content is as wide as the spec promises and
  // the guard behind it cannot stand in for the rule under test.
  test('overlapping segments are refused, because a shared line prints once per matching p', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,5p;3,8p' notes.txt" },
      content: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk',
    });
    assert.deepEqual(completed.effects, []);
  });

  // A line break the spec class admits is a command separator too, and the segments after it belong to a
  // command sed never ran. The result is one the spec would account for in full, so only the trailing
  // segment can decide the refusal.
  test('a line break inside the spec refuses the read', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'sed -n 1,2p;\n3,4p notes.txt' }, content: 'l1\nl2\nl3\nl4',
    });
    assert.deepEqual(completed.effects, []);
  });

  test('a segment this rule cannot read refuses the whole spec', () => {
    const commands = [
      "sed -n '1,2p;/foo/p' notes.txt", "sed -n '1,2' notes.txt",
      "sed -n '0,2p' notes.txt", "sed -n '6,2p' notes.txt",
    ];
    for (const command of commands) {
      const { completed } = runTool({ name: 'Bash', input: { command }, content: 'a\nb' });
      assert.deepEqual(completed.effects, [], command);
    }
  });

  test('a cat piped into a sed range keys the lines the range names', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "cat notes.txt | sed -n '4,6p'" }, content: 'four\nfive\nsix\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [4, 5, 6, 7]);
  });

  // Narrower than the spec promises, which is the direction a large range read comes back in. A single
  // segment keys consecutively from its start address, so those keys hold however short the output is —
  // the equality a multi-segment spec is held to must not reach this case.
  test('a single segment keeps the tolerance for a result narrower than its spec', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "cat notes.txt | sed -n '4,10p'" }, content: 'four\nfive\nsix\n',
    });
    assert.deepEqual(onlyImpact(onlyEffect(completed)).mutation.fragments.map(f => f.key), [4, 5, 6, 7]);
  });

  test('a cat piped into a sed spec this rule cannot read locates nothing', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "cat notes.txt | sed -n '/foo/,/bar/p'" }, content: 'a\nb',
    });
    assert.deepEqual(completed.effects, []);
  });

  // The spec class admits `;`, so a segment list can run past a shell separator into a command sed never
  // ran, and the path ahead of the pipe would be credited with its output. The result is one the spec
  // would account for in full, so only the trailing segment can decide the refusal.
  test('a trailing segment after a cat-piped sed refuses the read', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cat notes.txt | sed -n 1,2p;3,4p' }, content: 'l1\nl2\nl3\nl4',
    });
    assert.deepEqual(completed.effects, []);
  });

  test('a cat -n tail keys from the spec, not from the numbers cat printed', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '20,22p' notes.txt | cat -n" },
      content: '     1\ttwenty\n     2\ttwentyone\n     3\ttwentytwo\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [20, 21, 22, 23]);
  });

  // As wide as the spec promises, and single-segment besides, so no width judgment stands between the
  // missing prefix and the refusal.
  test('a cat -n tail whose output carries no number prefix is refused', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '20,22p' notes.txt | cat -n" }, content: 'twenty\ntwentyone\ntwentytwo',
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
  });

  // `cat -n` prefixes every line it forwards, so an empty line anywhere but the trailing one a final
  // newline yields says the result is not the shape the command describes.
  test('a cat -n tail whose output holds an empty line short of the end is refused', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '20,22p' notes.txt | cat -n" },
      content: '     1\ttwenty\n\n     3\ttwentytwo\n',
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
  });

  test('a sed range after a numbered grep keys from the line numbers the grep printed', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "grep -n foo notes.txt | sed -n '1,2p'" }, content: '12:foo bar\n30:foo baz\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [12, 30]);
  });

  test('a sed range after a numbered grep over a cat keys from the printed numbers too', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "cat notes.txt | grep -n foo | sed -n '1,2p'" }, content: '5:foo\n9:foo\n',
    });
    assert.deepEqual(onlyImpact(onlyEffect(completed)).mutation.fragments.map(f => f.key), [5, 9]);
  });

  test('a discarded stderr leaves the sed range locatable', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '3,4p' notes.txt 2>/dev/null" }, content: 'three\nfour',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [3, 4]);
  });

  test('a heredoc write replaces the whole content under write access', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "cat <<'EOF' > out.txt\nhello\nworld\nEOF" }, content: '',
    });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'write');
    assert.equal(effect.overheadTokens, 90, 'heredoc content flows like a Write, so it carries Write framing');
    assert.equal(onlyImpact(effect).resourceKey, '/repo/out.txt');
  });

  test('a cd preamble anchors the target to the row base path, not the process directory', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cd src && cat auth.js' }, content: 'alpha\nbeta\n',
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/src/auth.js');
  });

  test('the last cd of a chain wins', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cd a && cd b && cat f.js' }, content: 'alpha\nbeta\n',
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/b/f.js');
  });

  test('a semicolon-joined cd preamble anchors the target like the && form', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cd src; cat auth.js' }, content: 'alpha\nbeta\n',
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/src/auth.js');
  });

  test('a one-line echo preamble is dropped from the priced result', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'echo "=== notes ===" && cat notes.txt' }, content: '=== notes ===\nalpha\nbeta\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/notes.txt');
    assertWholeContent(impact, 'alpha', 'beta', '');
  });

  test('an echo preamble ahead of a sed range still keys from the range start', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "echo '--- a ---'; sed -n '5,6p' notes.txt" }, content: '--- a ---\nfive\nsix',
    });
    assert.deepEqual(onlyImpact(onlyEffect(completed)).mutation.fragments.map(f => f.key), [5, 6]);
  });

  test('cd and echo preambles compose in either order', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'echo start; cd src && cat auth.js' }, content: 'start\nalpha\n',
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/src/auth.js');
    assertWholeContent(impact, 'alpha', '');
  });

  test('a tilde target resolves against the home directory', () => {
    const { completed } = runTool({ name: 'Bash', input: { command: 'cat ~/notes.txt' }, content: 'alpha\nbeta\n' });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, `${os.homedir()}/notes.txt`);
  });

  const EFFECTIVE = [
    ['cat notes.txt', '/repo/notes.txt'],
    ['cat -n notes.txt', '/repo/notes.txt'],
    ['head notes.txt', '/repo/notes.txt'],
    ['head -20 notes.txt', '/repo/notes.txt'],
    ['cat notes.txt | head', '/repo/notes.txt'],
    ['cat notes.txt | head | head', '/repo/notes.txt'],
    ['cat notes.txt | grep -n foo | head', '/repo/notes.txt'],
    ['head notes.txt | head', '/repo/notes.txt'],
    ['grep -n foo notes.txt', '/repo/notes.txt'],
    ['grep -n foo notes.txt | head', '/repo/notes.txt'],
    ['rg -n foo notes.txt', '/repo/notes.txt'],
    ['grep -n "a\\|b" notes.txt', '/repo/notes.txt'],
    // A pipe inside a quoted pattern is part of the pattern, not a stage separator, under either quote
    // character; and a combined short flag still counts as carrying -n.
    ["grep -n 'a|b' notes.txt", '/repo/notes.txt'],
    ['grep -nE "a|b" notes.txt', '/repo/notes.txt'],
    // Backslash parity decides whether a `|` splits the command: an odd run escapes the pipe, an even run
    // ends in a literal backslash and the pipe is real. Only an escaped pipe leaves one locatable segment.
    ['cat notes.txt \\| wc', '/repo/notes.txt'],
    ['cat notes.txt \\\\\\| wc', '/repo/notes.txt'],
    // A directory target resolves without its trailing separator, so one directory has one key.
    ['grep -n foo src/', '/repo/src'],
    ['grep -n --include=*.js pattern src/a.js', '/repo/src/a.js'],
    ['# describe the call\ncat notes.txt', '/repo/notes.txt'],
    ['fn22 && cat notes.txt', '/repo/notes.txt'],
    ["sed -n '1,3p' notes.txt", '/repo/notes.txt'],
    ['sed -n "1,3p" notes.txt', '/repo/notes.txt'],
    ['sed -n 1,3p notes.txt', '/repo/notes.txt'],
    ["sed -n -e '1,3p' notes.txt", '/repo/notes.txt'],
    ["sed -n '40,$p' notes.txt", '/repo/notes.txt'],
    ["sed -n '1,5p;9,12p' notes.txt", '/repo/notes.txt'],
    ["cd src && sed -n '1,3p' notes.txt", '/repo/src/notes.txt'],
    ["cat notes.txt | sed -n '1,3p'", '/repo/notes.txt'],
    ["grep -n foo notes.txt | sed -n '1,2p'", '/repo/notes.txt'],
    ["sed -n '1,3p' notes.txt 2>/dev/null", '/repo/notes.txt'],
    // A separator inside a quoted pattern is part of the pattern, so the command is still one segment.
    ["grep -n 'a;b' notes.txt", '/repo/notes.txt'],
    ['grep -n "a && b" notes.txt', '/repo/notes.txt'],
  ];
  // Grep-shaped so a `grep -n` entry can be keyed, and as wide as the widest spec in the table promises so
  // a width guard judges every entry against a result its own command could have printed in full.
  const EFFECTIVE_RESULT = '3:foo a\n7:foo b\n11:foo c\n13:foo d\n17:foo e\n19:foo f\n23:foo g\n29:foo h\n31:foo i\n';
  for (const [command, resourceKey] of EFFECTIVE) {
    test(`resolves a resident target: ${command.replace(/\n/g, '\\n')}`, () => {
      const { completed } = runTool({ name: 'Bash', input: { command }, content: EFFECTIVE_RESULT });
      assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, resourceKey);
    });
  }

  const NO_TARGET = [
    'npm test',
    'git log --oneline',
    'tail -20 notes.txt',
    'grep foo notes.txt',
    'grep -c foo notes.txt',
    'grep -ln foo notes.txt',
    'cat notes.txt \\\\| wc',
    'cat notes.txt | python3',
    'cat notes.txt | head | grep foo',
    'cat notes.txt || echo missing',
    'head notes.txt | python3',
    'head notes.txt || echo missing',
    'grep -n foo notes.txt | sort',
    'grep -n foo notes.txt | grep -v bar',
    'grep -n foo notes.txt || echo missing',
    'cat $(ls) ',
    'cat `ls`',
    'cat *.js',
    'head *.js',
    'cat ~alice/notes.txt',
    'cat ~+/notes.txt',
    'cat ~/$(whoami)/notes.txt',
    'grep -n foo ~/$(whoami)/notes.txt',
    'grep -n foo *.js',
    'grep -n foo .',
    'grep -n foo /dev/null',
    'grep -n "a b" -r',
    'cat > copy.txt',
    "cat <<'EOF'\nhello\nEOF",
    "cat <<'EOF' > out.txt\nhello",
    "cat <<'EOF' > $HOME/out.txt\nhello\nEOF",
    "sed -n '1,5p' notes.txt; echo done",
    "sed -n '1,5p' notes.txt && echo done",
    "sed -n '1,5p' notes.txt | wc -l",
    // A `cat`- or `head`-shaped result is keyed positionally from one, so a tail that drops lines out of
    // its middle would key every survivor to a line it does not occupy. Only a stage that numbered its
    // own lines survives one, which is why the line-dropping tail is admitted after a numbered grep alone.
    "head notes.txt | sed -n '2,3p'",
    "cat notes.txt | head | sed -n '2,3p'",
    "cat notes.txt | sed -n '1,3p' | head",
    "sed -i 's/a/b/' notes.txt",
    "sed -n '/foo/,/bar/p' notes.txt",
    // An unquoted `;` the spec class admits is a separator the shell acts on, so the token after it is
    // another command rather than this read's path.
    'sed -n 1,2p; ls',
    "sed -n '1,5p' *.txt",
    "sed -n '1,5p' $FILE",
    // The `cat`-into-`sed` anchor carries its own copy of each refusal the whole-command anchor makes: a
    // path the shell would expand, and a spec this rule cannot read.
    "cat *.js | sed -n '1,3p'",
    "cat $FILE | sed -n '1,3p'",
    "cat notes.txt | sed -n '6,2p'",
    "sed '1,5p' notes.txt",
    'echo -n hdr && cat notes.txt',
    'echo "$HOME" && cat notes.txt',
    'echo a b && cat notes.txt',
    'echo "a\nb" && cat notes.txt',
    'echo hdr || cat notes.txt',
    "grep -nE 'a' lib/x.js; grep -nA2 'b' lib/y.js",
    'grep -n foo notes.txt | head -40; echo; grep -n bar other.txt',
    'cat notes.txt; ls',
    'head -5 notes.txt && echo done',
    'grep -n foo notes.txt\nls',
    'cat notes.txt | head -3; echo x',
  ];
  for (const command of NO_TARGET) {
    test(`resolves no resident target: ${command.replace(/\n/g, '\\n')}`, () => {
      const { completed } = runTool({ name: 'Bash', input: { command }, content: 'some output' });
      assert.deepEqual(completed.effects, [], command);
      assert.equal(completed.residuals.length, 1, 'a Bash call with no resident target is residual evidence');
      assert.deepEqual(completed.telemetry.pathEvents, []);
    });
  }

  test('a heredoc body line that looks like a heredoc header does not retarget the write', () => {
    const command = "cat <<'EOF' > out.txt\ncat <<'INNER' > other.txt\nEOF";
    const { completed } = runTool({ name: 'Bash', input: { command }, content: '' });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/out.txt');
  });

  test('a heredoc write under a cd preamble anchors to the cd target', () => {
    const command = "cd src && cat <<'EOF' > out.txt\nhello\nEOF";
    const { completed } = runTool({ name: 'Bash', input: { command }, content: '' });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/src/out.txt');
  });

  test('a bash grep -n whose output is multi-file produces no phantom target and stays residual', () => {
    const input = { command: 'grep -n foo notes.txt' };
    const content = 'src/a.js:3:foo\nsrc/b.js:9:foo\n';
    const { completed } = runTool({ name: 'Bash', input, content });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
    assert.equal(completed.residuals[0].groupKey, 'grep');
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + content.length);
  });

  test('a matched bash target whose result errored falls back to a residual carrying the error state', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cat notes.txt' },
      content: 'cat: notes.txt: Permission denied', isError: true,
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
    assert.equal(completed.residuals[0].hadError, true);
    assert.equal(completed.residuals[0].groupKey, 'cat');
  });

  test('a null-target bash call carries the result error state into its residual', () => {
    const ok = runTool({ name: 'Bash', input: { command: 'npm test' }, content: 'passed' });
    assert.equal(ok.completed.residuals[0].hadError, false);
    const failed = runTool({ name: 'Bash', input: { command: 'npm test' }, content: 'failed', isError: true });
    assert.equal(failed.completed.residuals[0].hadError, true);
  });

  test('a null-target bash residual weighs its serialized input plus its result text', () => {
    const input = { command: 'npm test' };
    const { completed } = runTool({ name: 'Bash', input, content: 'x'.repeat(500) });
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + 500);
  });
});

// ─── Bash compound read chains ───────────────────────────────────────────────

describe('Bash compound reads', () => {
  // A corpus shape: two range reads joined by a one-literal echo divider.
  const SED_SED = {
    command: "sed -n '123,136p' packages/analytics/src/pages.ts; echo \"=== dialog.ts 64,72 ===\"; sed -n '64,72p' packages/analytics/src/dialog.ts",
    content: "// Page object for auth page\nexport type AuthAction =\n    'UNKNOWN' |\n=== dialog.ts 64,72 ===\n  YOUR_PRIVACY = 'YOUR_PRIVACY',\n  PRIVACY_PREFERENCES = 'PRIVACY_PREFERENCES',",
  };

  test('each read between echo dividers becomes its own effect keyed from its range start', () => {
    const { completed } = runTool({ name: 'Bash', input: { command: SED_SED.command }, content: SED_SED.content });
    assert.equal(completed.effects.length, 2);
    const [first, second] = completed.effects.map(onlyImpact);
    assert.equal(first.resourceKey, '/repo/packages/analytics/src/pages.ts');
    assert.deepEqual(first.mutation.fragments.map(f => f.key), [123, 124, 125]);
    assert.equal(second.resourceKey, '/repo/packages/analytics/src/dialog.ts');
    assert.deepEqual(second.mutation.fragments.map(f => f.key), [64, 65]);
    assert.deepEqual(completed.residuals, []);
  });

  test('one call carries one framing overhead however many blocks it prices', () => {
    const { completed } = runTool({ name: 'Bash', input: { command: SED_SED.command }, content: SED_SED.content });
    assert.equal(completed.effects.reduce((s, e) => s + e.overheadTokens, 0), TOOL_OVERHEAD.Bash);
    const second = completed.effects[1];
    assert.equal(second.spentTokens, second.impacts[0].mutation.fragments.reduce((s, f) => s + f.tokens, 0));
  });

  test('a cat block replaces the whole resource and a cd segment anchors every later read', () => {
    const { completed } = runTool({
      name: 'Bash',
      input: { command: 'cd /tmp/pr35667 && echo "=== useAddPlaylistItem ===" && cat src/hooks/useAdd.ts; echo "=== useInvalidate ===" && cat src/hooks/useInvalidate.ts' },
      content: '=== useAddPlaylistItem ===\nexport const a = 1;\n=== useInvalidate ===\nexport const b = 2;\n',
    });
    assert.equal(completed.effects.length, 2);
    const [first, second] = completed.effects.map(onlyImpact);
    assert.equal(first.resourceKey, '/tmp/pr35667/src/hooks/useAdd.ts');
    assertWholeContent(first, 'export const a = 1;');
    assert.equal(second.resourceKey, '/tmp/pr35667/src/hooks/useInvalidate.ts');
    assertWholeContent(second, 'export const b = 2;');
  });

  test('a block nobody can locate stays one residual weighted by its own bytes beside the priced blocks', () => {
    const input = { command: "echo '--- fold.js 318-340'; sed -n '318,340p' lib/fold.js; echo '--- G_DELTA_CAP'; grep -rn \"G_DELTA_CAP\" lib/*.js | head -5" };
    const grepBlock = 'lib/constants.js:12:export const G_DELTA_CAP = 1;\nlib/l-measure.js:40:  G_DELTA_CAP,';
    const { completed } = runTool({
      name: 'Bash', input, content: `--- fold.js 318-340\nline a\nline b\n--- G_DELTA_CAP\n${grepBlock}`,
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/lib/fold.js');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [318, 319]);
    assert.equal(completed.residuals.length, 1);
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + grepBlock.length);
    assert.equal(completed.residuals[0].groupKey, 'sed');
    assert.equal(completed.residuals[0].meta.kind, 'bash');
  });

  test('a divider literal that also occurs inside a file leaves the whole call residual', () => {
    const input = { command: "sed -n '1,3p' a.txt; echo \"---\"; sed -n '1,3p' b.txt" };
    const content = 'x\n---\ny\n---\nz\nw';
    const { completed } = runTool({ name: 'Bash', input, content });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + content.length);
  });

  test('dividers printed out of command order leave the whole call residual', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,2p' a.txt; echo \"=== A ===\"; sed -n '1,2p' b.txt; echo \"=== B ===\"; sed -n '1,2p' c.txt" },
      content: '=== B ===\nm1\n=== A ===\nl1',
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
  });

  test('a divider the result never printed leaves the whole call residual', () => {
    const { completed } = runTool({ name: 'Bash', input: { command: SED_SED.command }, content: 'x\ny' });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
  });

  test('a persisted-output placeholder prices no block', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: SED_SED.command },
      content: '<persisted-output>\nOutput too large (120KB). Preview:\n// Page object\n=== dialog.ts 64,72 ===\nfoo\n</persisted-output>',
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
  });

  test('an errored chain carries the error state into its residual', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: SED_SED.command }, content: SED_SED.content, isError: true,
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals[0].hadError, true);
  });

  test('a read that failed mid-chain leaves its diagnostic line in the remainder, not on the file', () => {
    const input = { command: "sed -n '1,9p' gone.txt; echo \"=== b ===\"; sed -n '1,2p' b.txt" };
    const diagnostic = "sed: can't read gone.txt: No such file or directory";
    const { completed } = runTool({ name: 'Bash', input, content: `${diagnostic}\n=== b ===\nl1\nl2` });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/b.txt');
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + diagnostic.length);
  });

  test('a cat that failed mid-chain does not replace its resource with the diagnostic', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cat gone.txt; echo "=== b ==="; cat b.txt' },
      content: 'cat: gone.txt: No such file or directory\n=== b ===\nB',
    });
    assert.deepEqual(completed.effects.map(e => onlyImpact(e).resourceKey), ['/repo/b.txt']);
  });

  test('a directory change the chain cannot read leaves the whole call residual', () => {
    for (const command of [
      'cd /workspace/src 2>/dev/null; cat a.txt; echo "---"; cat b.txt',
      'pushd /x > /dev/null; cat a.txt; echo "---"; cat b.txt',
      'cd "/tmp/my dir" && cat a.txt; echo "---"; cat b.txt',
    ]) {
      const { completed } = runTool({ name: 'Bash', input: { command }, content: 'A\n---\nB' });
      assert.deepEqual(completed.effects, [], command);
      assert.equal(completed.residuals.length, 1, command);
    }
  });

  test('a block whose read printed nothing leaves its resource untouched', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cat a.txt > /tmp/o; echo "---"; cat b.txt' }, content: '---\nB',
    });
    assert.deepEqual(completed.effects.map(e => onlyImpact(e).resourceKey), ['/repo/b.txt']);
  });

  test('two blocks reading one file merge into that resource under their own keys', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,2p' f.txt; echo \"=== 225-330 ===\"; sed -n '225,226p' f.txt" },
      content: 'l1\nl2\n=== 225-330 ===\nm1\nm2',
    });
    const impacts = completed.effects.map(onlyImpact);
    assert.deepEqual(impacts.map(i => i.resourceKey), ['/repo/f.txt', '/repo/f.txt']);
    assert.deepEqual(impacts.map(i => i.mutation.fragments.map(f => f.key)), [[1, 2], [225, 226]]);
  });

  test('an echo of an empty string is a bare echo, not a divider', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,3p' a.txt; echo \"\"; echo \"---\"; sed -n '1,2p' b.txt" },
      content: 'l1\n\nl3\n\n---\nm1\nm2',
    });
    assert.equal(completed.effects.length, 2);
    assert.deepEqual(onlyImpact(completed.effects[0]).mutation.fragments.map(f => f.key), [1, 2, 3]);
  });

  test('the harness cwd-reset trailer after the last block is not that block\'s content', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cd /tmp/x && echo "=== a ===" && cat a.txt; echo "=== b ===" && cat b.txt' },
      content: '=== a ===\nA\n=== b ===\nB\nShell cwd was reset to /repo',
    });
    assert.equal(completed.effects.length, 2);
    assertWholeContent(onlyImpact(completed.effects[1]), 'B');
  });

  test('a range block wider than its promised count is refused into the remainder', () => {
    const input = { command: "sed -n '1,2p' a.txt; echo \"---\"; sed -n '1,2p' b.txt" };
    const { completed } = runTool({ name: 'Bash', input, content: 'l1\nl2\nl3\n---\nm1\nm2' });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/b.txt');
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + 'l1\nl2\nl3'.length);
  });

  test('a byte-count head block wider than head\'s default line count is refused', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const { completed } = runTool({
      name: 'Bash', input: { command: 'ls -la dist/providers/ | head -20; echo "=== head of xai.models.js ==="; head -c 1200 dist/providers/xai.models.js' },
      content: `=== head of xai.models.js ===\n${lines}`,
    });
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
  });

  test('a numbered-grep block holding a context line is refused into the remainder', () => {
    const input = { command: "grep -n 'foo' a.js; echo \"---\"; grep -n -A1 'bar' b.js" };
    const { completed } = runTool({ name: 'Bash', input, content: '3:foo\n---\n7:bar\n8-baz' });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/a.js');
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + '7:bar\n8-baz'.length);
  });

  test('a bare echo after a read accounts for the empty line it prints', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "sed -n '1,2p' a.txt; echo; echo \"---\"; sed -n '1,2p' b.txt" },
      content: 'l1\nl2\n\n---\nm1\nm2',
    });
    assert.equal(completed.effects.length, 2);
    assert.deepEqual(onlyImpact(completed.effects[0]).mutation.fragments.map(f => f.key), [1, 2]);
  });

  test('a bare echo ahead of a read accounts for the empty line it prints', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "echo; sed -n '1,2p' a.txt; echo \"---\"; sed -n '1,2p' b.txt" },
      content: '\nl1\nl2\n---\nm1\nm2',
    });
    assert.equal(completed.effects.length, 2);
    assert.deepEqual(onlyImpact(completed.effects[0]).mutation.fragments.map(f => f.key), [1, 2]);
  });

  test('each priced block reports one path event with its own read shape', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cat a.txt; echo "---"; sed -n \'4,5p\' b.txt' },
      content: 'A\n---\nfour\nfive',
    });
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: '/repo/a.txt', rawPath: '/repo/a.txt', toolType: 'Bash', isFullRead: 1 },
      { path: '/repo/b.txt', rawPath: '/repo/b.txt', toolType: 'Bash', isFullRead: 0 },
    ]);
  });

  test('a multi-segment block inside a chain is priced, not refused by the width guard', () => {
    const { completed } = runTool({
      name: 'Bash',
      input: { command: "sed -n '1,2p;5,6p' a.txt; echo \"=== b ===\"; sed -n '1,2p' b.txt" },
      content: 'l1\nl2\nl5\nl6\n=== b ===\nm1\nm2',
    });
    assert.equal(completed.effects.length, 2);
    const impacts = completed.effects.map(onlyImpact);
    assert.deepEqual(impacts.map(i => i.resourceKey), ['/repo/a.txt', '/repo/b.txt']);
    assert.deepEqual(impacts[0].mutation.fragments.map(f => f.key), [1, 2, 5, 6]);
  });

  test('an open-ended block is priced, because its command promises no count to judge it by', () => {
    const { completed } = runTool({
      name: 'Bash',
      input: { command: "sed -n '3,$p' a.txt; echo \"=== b ===\"; sed -n '1,2p' b.txt" },
      content: 'l3\nl4\nl5\n=== b ===\nm1\nm2',
    });
    assert.equal(completed.effects.length, 2);
    assert.deepEqual(onlyImpact(completed.effects[0]).mutation.fragments.map(f => f.key), [3, 4, 5]);
  });

  test('a multi-segment block wider than its spec goes to the remainder', () => {
    const input = { command: "sed -n '1,2p;5,6p' a.txt; echo \"=== b ===\"; sed -n '1,2p' b.txt" };
    const { completed } = runTool({ name: 'Bash', input, content: 'l1\nl2\nl5\nl6\nl7\n=== b ===\nm1\nm2' });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/b.txt');
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + 'l1\nl2\nl5\nl6\nl7'.length);
  });

  // A single `|` is not a segment separator, so a pipeline is one block and reaches the same width guard as
  // its whole-command twin. A line the read did not print would otherwise land on a key inside the file.
  test('a cat-into-sed block wider than its spec goes to the remainder', () => {
    const input = { command: "cat a.txt | sed -n '1,2p'; echo \"=== b ===\"; sed -n '1,2p' b.txt" };
    const { completed } = runTool({ name: 'Bash', input, content: 'l1\nl2\nl3\n=== b ===\nm1\nm2' });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/b.txt');
    assert.equal(completed.residuals[0].weight, JSON.stringify(input).length + 'l1\nl2\nl3'.length);
  });

  test('a cat-into-sed block no wider than its spec is priced from the spec', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: "cat a.txt | sed -n '4,6p'; echo \"=== b ===\"; sed -n '1,2p' b.txt" },
      content: 'four\nfive\nsix\n=== b ===\nm1\nm2',
    });
    assert.equal(completed.effects.length, 2);
    const impacts = completed.effects.map(onlyImpact);
    assert.deepEqual(impacts.map(i => i.resourceKey), ['/repo/a.txt', '/repo/b.txt']);
    assert.deepEqual(impacts[0].mutation.fragments.map(f => f.key), [4, 5, 6]);
  });
});

// ─── Bash feature naming and redaction ──────────────────────────────────────

describe('bash residual naming', () => {
  const CASES = [
    ['git log --oneline -20', 'git log', ''],
    ['cd /workspace && npm test', 'npm test', ''],
    ['fn22 && pnpm test:client', 'pnpm test:client', ''],
    ['FOO=bar BAZ=1 curl https://api.example.com/v1', 'curl', 'api.example.com'],
    ['git -C /some/path log', 'git log', ''],
    ['bash scripts/deploy.sh', 'bash deploy.sh', ''],
    ['python3 << "EOF"\nprint("hi")\nEOF', 'python3', '<<'],
    ['node -e "console.log(1)"', 'node', ''],
    ['sudo docker compose up', 'docker compose', 'up'],
    ['cat /home/alice/foo | grep bar', 'grep', '/home/alice/foo'],
    ['AWS_SECRET=abc123 npm run deploy', 'npm run', 'deploy'],
    ['/usr/local/bin/custom-tool', '(script)', ''],
    ['source ~/.bashrc; git status', 'git status', ''],
    ['', '(bash)', ''],
    ['sudo env docker ps', 'docker ps', ''],
    ['time sudo nohup curl https://x.example.com/y', 'curl', 'x.example.com'],
    ['# desc\ngit status', 'git status', ''],
    ['# one\n# two\ngit status', 'git status', ''],
    ['# only a comment', '(bash)', ''],
    ['echo hello # world', 'echo', 'hello'],
    ['# desc\r\ngit status', 'git status', ''],
    ['VAR=x\n# desc\ngit status', 'git status', ''],
    ['ls /home/alice/secrets', 'ls', '~/secrets'],
    ['ssh alice@10.0.0.1', 'ssh', '***@<ip>'],
    ['echo AWS_SECRET=abc123', 'echo', 'AWS_SECRET=***'],
    ['cd /workspace; git status', 'git status', ''],
    ['cd /workspace; wc -l a.md', 'wc', 'a.md'],
    ["echo '=== hdr ===' && sed -n '1,5p' a.js; echo; sed -n '9,12p' a.js", 'sed', 'a.js;'],
    ['echo start; cd src && npm test', 'npm test', ''],
    ['echo -n hdr && npm test', 'echo', 'hdr'],
  ];
  for (const [command, groupKey, detail] of CASES) {
    test(`names ${JSON.stringify(command.slice(0, 44))} as ${groupKey}`, () => {
      const { completed } = runTool({ name: 'Bash', input: { command }, content: 'out' });
      assert.equal(completed.residuals.length, 1, command);
      assert.equal(completed.residuals[0].groupKey, groupKey, command);
      assert.equal(completed.residuals[0].meta.kind, 'bash');
      assert.equal(completed.residuals[0].meta.detail, detail, command);
    });
  }

  test('a residual name and detail are each capped', () => {
    const long = 'a'.repeat(80);
    const { completed } = runTool({ name: 'Bash', input: { command: `${long} ${long}` }, content: 'out' });
    assert.equal(completed.residuals[0].groupKey.length, 40);
    assert.equal(completed.residuals[0].meta.detail.length, 40);
  });

  test('a secret in the raw command never reaches the residual', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'echo API_TOKEN=s3cr3tvalue' }, content: 'out',
    });
    const serialized = JSON.stringify(completed.residuals);
    assert.ok(!serialized.includes('s3cr3tvalue'), serialized);
  });
});

describe('redactCmd', () => {
  const CASES = [
    ['AWS_SECRET=abc123 npm run', 'AWS_SECRET=***', 'abc123'],
    ['API_TOKEN=xyz curl', 'API_TOKEN=***', 'xyz'],
    ['cat /home/alice/.ssh/id', '~', null],
    ['cat /root/data', '~', null],
    ['scp user@10.0.0.1:/x .', '***@<ip>', null],
    ['--token abc123', '--token ***', 'abc123'],
    ['Bearer eyJhbGc...', 'Bearer ***', 'eyJhbGc'],
    ['https://admin:s3cr3t@api.example.com', '***:***@', 's3cr3t'],
  ];
  for (const [cmd, expected, leak] of CASES) {
    test(`masks ${JSON.stringify(cmd)}`, () => {
      const out = redactCmd(cmd);
      assert.ok(out.includes(expected), out);
      if (leak) assert.ok(!out.includes(leak), out);
    });
  }

  test('a clean command passes through unchanged', () => {
    assert.equal(redactCmd('npm test'), 'npm test');
    assert.equal(redactCmd('git log --oneline'), 'git log --oneline');
  });

  test('the dashboard copy produces identical output', () => {
    const all = CASES.map(([cmd]) => cmd).concat(['npm test', 'git log --oneline']);
    for (const cmd of all) assert.equal(redactCmd(cmd), redactCmdFrontend(cmd), cmd);
  });
});

// ─── MCP ─────────────────────────────────────────────────────────────────────

describe('MCP residual naming', () => {
  const CASES = [
    ['mcp__serena__onboarding', 'serena onboarding'],
    ['mcp__serena__list_memories', 'serena list_memories'],
    ['mcp__serena__initial_instructions', 'serena initial_instructions'],
    ['mcp__plugin_playwright_playwright__browser_evaluate', 'playwright browser_evaluate'],
    ['mcp__plugin_session-watcher_session-watcher__start_watcher', 'session-watcher start_watcher'],
  ];
  for (const [name, groupKey] of CASES) {
    test(`names ${name} as ${groupKey}`, () => {
      const { completed } = runTool({ name, input: { q: 'x' }, content: 'y'.repeat(300) });
      assert.deepEqual(completed.effects, []);
      assert.equal(completed.residuals.length, 1);
      assert.equal(completed.residuals[0].groupKey, groupKey);
      assert.equal(completed.residuals[0].meta.kind, 'mcp');
      assert.equal(completed.residuals[0].meta.detail, '');
    });
  }

  test('an unmatched MCP call carries the result error state into its residual', () => {
    const ok = runTool({ name: 'mcp__serena__onboarding', input: {}, content: 'fine' });
    assert.equal(ok.completed.residuals[0].hadError, false);
    const failed = runTool({ name: 'mcp__serena__onboarding', input: {}, content: 'broke', isError: true });
    assert.equal(failed.completed.residuals[0].hadError, true);
  });

  test('an unmatched tool that is neither Bash nor MCP correlates nothing', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'WebFetch', input: { url: 'https://example.com' } }),
      makeContext(),
    );
    assert.equal(started.pending, null);
    assert.equal(started.telemetry.toolUseId, 'tu1');
  });
});

// ─── Serena ──────────────────────────────────────────────────────────────────

describe('Serena', () => {
  const FIND_SYMBOL_ONE_FILE = SERENA_OK([
    { relative_path: 'lib/x.js', body_location: { start_line: 4, end_line: 6 }, body: 'function f() {\n  return 1;\n}' },
  ]);

  test('find_symbol scoped to one file merges its body lines', () => {
    const { completed } = runTool({
      name: 'mcp__serena__find_symbol',
      input: { relative_path: 'lib/x.js', name_path: 'f' },
      content: FIND_SYMBOL_ONE_FILE,
    });
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 50);
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, '/repo/lib/x.js');
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [5, 6, 7]);
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: '/repo/lib/x.js', rawPath: '/repo/lib/x.js', toolType: 'serena_find_symbol', isFullRead: 0 },
    ]);
  });

  test('a project-wide find_symbol is a matched null-target call that still completes with an effect', () => {
    const content = SERENA_OK([
      { relative_path: 'lib/x.js', body_location: { start_line: 0 }, body: 'const x = 1;' },
      { relative_path: 'lib/y.js', body_location: { start_line: 2 }, body: 'const y = 2;' },
    ]);
    const { started, completed } = runTool({
      name: 'mcp__serena__find_symbol', input: { name_path: 'x' }, content,
    });
    assert.ok(started.pending, 'a matched multi-file call still correlates');
    const effect = onlyEffect(completed);
    assert.deepEqual(effect.impacts.map(i => i.resourceKey).sort(), ['/repo/lib/x.js', '/repo/lib/y.js']);
    assert.deepEqual(completed.residuals, []);
    assert.equal(completed.telemetry.pathEvents.length, 2);
    for (const event of completed.telemetry.pathEvents) {
      assert.equal(event.rawPath, event.path, 'a multi-file path event repeats its canonical path');
      assert.equal(event.toolType, 'serena_find_symbol');
      assert.equal(event.isFullRead, 0);
    }
  });

  test('find_symbol with no body content produces nothing', () => {
    const content = SERENA_OK([{ relative_path: 'lib/x.js', body_location: { start_line: 1 } }]);
    const { completed } = runTool({
      name: 'mcp__serena__find_symbol', input: { relative_path: 'lib/x.js' }, content,
    });
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
  });

  test('a truncated find_symbol produces nothing', () => {
    const { completed } = runTool({
      name: 'mcp__serena__find_symbol', input: { relative_path: 'lib/x.js' },
      content: SERENA_OK('Matched 40>max_matches=10 symbols.'),
    });
    assert.deepEqual(completed.effects, []);
  });

  test('find_referencing_symbols merges the context lines of every referencing file', () => {
    const content = SERENA_OK({
      'lib/y.js': { function: [{ body_location: { start_line: 9 }, content_around_reference: '  callIt();\n  more();' }] },
    });
    const { completed } = runTool({
      name: 'mcp__serena__find_referencing_symbols', input: { name_path: 'f' }, content,
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/lib/y.js');
    assert.equal(impact.mutation.kind, 'merge-fragments');
    assert.deepEqual(impact.mutation.fragments.map(f => f.key), [10, 11]);
    assert.equal(completed.telemetry.pathEvents[0].toolType, 'serena_find_referencing_symbols');
  });

  test('find_referencing_symbols with no context produces nothing', () => {
    const content = SERENA_OK({ 'lib/y.js': { function: [{ body_location: { start_line: 9 } }] } });
    const { completed } = runTool({
      name: 'mcp__serena__find_referencing_symbols', input: {}, content,
    });
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
  });

  test('read_memory replaces the whole content of the memory file it names', () => {
    const { completed } = runTool({
      name: 'mcp__serena__read_memory', input: { memory_name: 'core' },
      content: SERENA_OK('first line\nsecond line'),
    });
    const impact = onlyImpact(onlyEffect(completed));
    assert.equal(impact.resourceKey, '/repo/.serena/memories/core.md');
    assertWholeContent(impact, 'first line', 'second line');
    assert.equal(completed.telemetry.pathEvents[0].isFullRead, 1);
  });

  test('read_memory does not double-add the markdown suffix', () => {
    const { completed } = runTool({
      name: 'mcp__serena__read_memory', input: { memory_name: 'core.md' },
      content: SERENA_OK('first line\nsecond line'),
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/.serena/memories/core.md');
  });

  test('get_symbols_overview is matched but never effective', () => {
    const { started, completed } = runTool({
      name: 'mcp__serena__get_symbols_overview', input: { relative_path: 'lib/x.js' },
      content: SERENA_OK({ 'lib/x.js': ['f', 'g'] }),
    });
    assert.ok(started.pending);
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
  });

  const WRITES = [
    ['mcp__serena__replace_content', { relative_path: 'lib/z.js', needle: 'a', repl: 'bbbb' }],
    ['mcp__serena__replace_symbol_body', { relative_path: 'lib/z.js', body: 'function f() {}' }],
    ['mcp__serena__insert_after_symbol', { relative_path: 'lib/z.js', body: 'const added = 1;' }],
    ['mcp__serena__insert_before_symbol', { relative_path: 'lib/z.js', body: 'const added = 1;' }],
  ];
  for (const [name, input] of WRITES) {
    test(`${name} adjusts the resource total`, () => {
      const { completed } = runTool({ name, input, content: SERENA_OK('ok') });
      const effect = onlyEffect(completed);
      assert.equal(effect.access, 'write');
      assert.equal(effect.overheadTokens, 0);
      const impact = onlyImpact(effect);
      assert.equal(impact.resourceKey, '/repo/lib/z.js');
      assert.equal(impact.mutation.kind, 'adjust-total');
      assert.equal(completed.telemetry.pathEvents[0].isFullRead, null);
    });

    test(`${name} produces nothing on a Serena error result`, () => {
      const { completed } = runTool({ name, input, content: SERENA_ERROR });
      assert.deepEqual(completed.effects, []);
      assert.deepEqual(completed.residuals, []);
    });
  }

  // An insert's whole body enters the file, so the signed adjustment IS that body priced under the model's
  // CTP pair. The magnitude is priced, user-visible content: it reaches `getBucketData().paths[].tokens`,
  // so a zero or a sign flip here silently under- or over-reports the resource for the rest of the segment.
  for (const name of ['mcp__serena__insert_after_symbol', 'mcp__serena__insert_before_symbol']) {
    test(`${name} adjusts the total by the inserted body priced under the model CTP`, () => {
      const body = 'const added = 1;\nconst alsoAdded = 2;\n';
      const { completed } = runTool({
        name, input: { relative_path: 'lib/z.js', body }, content: SERENA_OK('ok'),
      });
      const expected = charsToTokens(body, CLAUDE_CTP);
      assert.ok(expected > 0, 'precondition: the fixture body prices above zero');
      assert.equal(onlyImpact(onlyEffect(completed)).mutation.deltaTokens, expected);
    });
  }

  test('a growing replace_content adjusts the total upward', () => {
    const needle = 'a';
    const repl = 'b'.repeat(400);
    const { completed } = runTool({
      name: 'mcp__serena__replace_content',
      input: { relative_path: 'lib/z.js', needle, repl },
      content: SERENA_OK('ok'),
    });
    const delta = onlyImpact(onlyEffect(completed)).mutation.deltaTokens;
    assert.ok(delta > 0, `a longer replacement grows the resource: got ${delta}`);
    assert.equal(delta, charsToTokens(repl, CLAUDE_CTP) - charsToTokens(needle, CLAUDE_CTP));
  });

  test('replace_symbol_body assumes a net-zero total change', () => {
    const { completed } = runTool({
      name: 'mcp__serena__replace_symbol_body',
      input: { relative_path: 'lib/z.js', body: 'function f() { return 1; }' },
      content: SERENA_OK('ok'),
    });
    assert.equal(onlyImpact(onlyEffect(completed)).mutation.deltaTokens, 0);
  });

  test('a shrinking replace_content adjusts the total downward', () => {
    const { completed } = runTool({
      name: 'mcp__serena__replace_content',
      input: { relative_path: 'lib/z.js', needle: 'a'.repeat(400), repl: 'b' },
      content: SERENA_OK('ok'),
    });
    assert.ok(onlyImpact(onlyEffect(completed)).mutation.deltaTokens < 0);
  });

  test('a non-literal replace_content mode produces nothing', () => {
    const { completed } = runTool({
      name: 'mcp__serena__replace_content',
      input: { relative_path: 'lib/z.js', needle: 'a', repl: 'b', mode: 'regex' },
      content: SERENA_OK('ok'),
    });
    assert.deepEqual(completed.effects, []);
  });

  test('an errored find_symbol result produces nothing', () => {
    const { completed } = runTool({
      name: 'mcp__serena__find_symbol', input: { relative_path: 'lib/x.js' }, content: SERENA_ERROR,
    });
    assert.deepEqual(completed.effects, []);
  });
});

// ─── Skill ───────────────────────────────────────────────────────────────────

describe('Skill', () => {
  function skillPair(content, isError) {
    return runTool({ name: 'Skill', input: { skill: 'brainstorming' }, content, isError });
  }

  test('a successful Skill result priced the confirmation and hands over a payload continuation', () => {
    const { completed } = skillPair('Launching skill: brainstorming');
    const effect = onlyEffect(completed);
    assert.equal(effect.access, 'read');
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, 'skill:brainstorming');
    assertWholeContent(impact, 'Launching skill: brainstorming');
    assert.deepEqual(completed.skillContinuation, {
      resourceKey: 'skill:brainstorming',
      issuingPolicy: modelPolicyFor(MODEL),
    });
    assert.deepEqual(completed.telemetry.pathEvents, [
      { path: 'skill:brainstorming', rawPath: 'skill:brainstorming', toolType: 'Skill', isFullRead: 1 },
    ]);
  });

  test('an errored Skill result hands over no continuation', () => {
    const { completed } = skillPair('skill unavailable', true);
    assert.equal(completed.skillContinuation, null);
    assert.deepEqual(completed.effects, []);
  });

  test('a payload replaces the whole content of the skill resource', () => {
    const { completed } = skillPair('Launching skill: brainstorming');
    const payload = interpretClaudeCodeSkillPayload(
      completed.skillContinuation,
      { type: 'skill-payload', toolUseId: 'tu1', text: 'the real skill body\nsecond line', sourceOrdinal: 3 },
    );
    const effect = onlyEffect(payload);
    assert.equal(effect.access, 'read');
    assert.equal(effect.overheadTokens, 40);
    const impact = onlyImpact(effect);
    assert.equal(impact.resourceKey, 'skill:brainstorming');
    assertWholeContent(impact, 'the real skill body\nsecond line');
    assert.deepEqual(payload.residuals, []);
  });

  test('an empty payload produces no effect', () => {
    const { completed } = skillPair('Launching skill: brainstorming');
    const payload = interpretClaudeCodeSkillPayload(
      completed.skillContinuation,
      { type: 'skill-payload', toolUseId: 'tu1', text: '', sourceOrdinal: 3 },
    );
    assert.deepEqual(payload.effects, []);
    assert.deepEqual(payload.residuals, []);
  });

  test('a payload is priced under the issuing step policy carried by the continuation', () => {
    const { completed } = skillPair('Launching skill: brainstorming');
    const text = '好'.repeat(100);
    const claude = interpretClaudeCodeSkillPayload(
      completed.skillContinuation,
      { type: 'skill-payload', toolUseId: 'tu1', text, sourceOrdinal: 3 },
    );
    const fallback = interpretClaudeCodeSkillPayload(
      { resourceKey: 'skill:brainstorming', issuingPolicy: modelPolicyFor('gpt-5') },
      { type: 'skill-payload', toolUseId: 'tu1', text, sourceOrdinal: 3 },
    );
    assert.notEqual(
      onlyImpact(onlyEffect(claude)).mutation.fragments[0].tokens,
      onlyImpact(onlyEffect(fallback)).mutation.fragments[0].tokens,
    );
  });
});

// ─── Task notification ───────────────────────────────────────────────────────

describe('task notification', () => {
  const text = [
    '<task-notification>',
    '<task-id>abcdef1234567890</task-id>',
    '<summary>Agent "Explore" finished</summary>',
    '</task-notification>',
  ].join('\n');

  test('one generic residual candidate with the agent group key and normalized detail', () => {
    const out = interpretClaudeCodeTaskNotification({
      type: 'task-notification', text, sourceOrdinal: 4, sourceEntryId: 'u4', timestamp: 4000,
    });
    assert.deepEqual(out.effects, []);
    assert.equal(out.telemetry, null);
    assert.equal(out.residuals.length, 1);
    assert.deepEqual(out.residuals[0], {
      groupKey: 'agent:abcdef12',
      weight: text.length,
      hadError: false,
      meta: { kind: 'agent', detail: 'Explore' },
    });
  });

  test('a summary that is not the finished phrase is kept verbatim', () => {
    const other = '<task-notification><task-id>0123456789</task-id><summary>ran the sweep</summary></task-notification>';
    const out = interpretClaudeCodeTaskNotification({ type: 'task-notification', text: other });
    assert.equal(out.residuals[0].meta.detail, 'ran the sweep');
    assert.equal(out.residuals[0].groupKey, 'agent:01234567');
  });

  test('a notification without a summary falls back to the task id prefix as detail', () => {
    const bare = '<task-notification><task-id>fedcba9876543210</task-id></task-notification>';
    const out = interpretClaudeCodeTaskNotification({ type: 'task-notification', text: bare });
    assert.equal(out.residuals[0].meta.detail, 'fedcba98');
    assert.equal(out.residuals[0].groupKey, 'agent:fedcba98');
  });

  test('a notification without a task id still produces one candidate', () => {
    const bare = '<task-notification><summary>done</summary></task-notification>';
    const out = interpretClaudeCodeTaskNotification({ type: 'task-notification', text: bare });
    assert.equal(out.residuals.length, 1);
    assert.equal(out.residuals[0].groupKey, 'agent:');
    assert.equal(out.residuals[0].weight, bare.length);
  });
});

// ─── Target base path precedence ─────────────────────────────────────────────

describe('target base path', () => {
  test('the row cwd wins', () => {
    const { completed } = runTool({
      name: 'Read', input: { file_path: 'a.js' }, cwd: '/rowcwd', content: READ_FULL,
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/rowcwd/a.js');
  });

  // A Windows-style separator names the same resource as its POSIX spelling, so one file cannot hold two
  // keys depending on which shell wrote the tool input.
  test('a backslash-separated path resolves to one POSIX key', () => {
    const { completed } = runTool({
      name: 'Read', input: { file_path: 'src\\lib\\auth.js' }, content: READ_FULL,
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/src/lib/auth.js');
  });

  test('the immutable session directory is next', () => {
    const { completed } = runTool({ name: 'Read', input: { file_path: 'a.js' }, content: READ_FULL });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/a.js');
  });

  test('the transcript directory is last', () => {
    const { completed } = runTool({
      name: 'Read', input: { file_path: 'a.js' }, content: READ_FULL,
      context: makeContext({ sessionCwd: null }),
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/transcripts/a.js');
  });

  test('result handling reuses the base path the tool use resolved', () => {
    const { completed } = runTool({
      name: 'Grep', input: { pattern: 'hit' }, cwd: '/rowcwd',
      content: 'src/a.js:10:first hit\n',
      context: makeContext(),
      completionContext: makeContext({ sessionCwd: '/elsewhere', transcriptDir: '/elsewhere' }),
    });
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/rowcwd/src/a.js');
  });

  test('a resolved target is frozen when the tool use is interpreted', () => {
    const use = useObservation({ name: 'Read', input: { file_path: 'first.js' } });
    const started = interpretClaudeCodeToolUse(use, makeContext());
    use.input.file_path = 'second.js';
    use.cwd = '/moved';
    const completed = completeClaudeCodeToolResult(started.pending, resultObservation({ content: READ_FULL }), makeContext());
    assert.equal(onlyImpact(onlyEffect(completed)).resourceKey, '/repo/first.js');
    assert.equal(completed.telemetry.pathEvents[0].rawPath, 'first.js');
  });

  test('completion eligibility is frozen when the tool use is interpreted', () => {
    const use = useObservation({ name: 'Bash', input: { command: 'npm test' } });
    const started = interpretClaudeCodeToolUse(use, makeContext());
    use.input.command = 'cat notes.txt';
    const completed = completeClaudeCodeToolResult(started.pending, resultObservation({ content: 'alpha\nbeta\n' }), makeContext());
    assert.deepEqual(completed.effects, []);
    assert.equal(completed.residuals.length, 1);
    assert.equal(completed.residuals[0].groupKey, 'npm test');
  });

  test('a single-target success keeps the native path input when file_path is absent', () => {
    const { completed } = runTool({
      name: 'mcp__serena__read_memory', input: { memory_name: 'core', path: '~/notes.md' },
      content: SERENA_OK('first\nsecond'),
    });
    assert.equal(completed.telemetry.pathEvents[0].rawPath, '~/notes.md');
    assert.equal(completed.telemetry.pathEvents[0].path, '/repo/.serena/memories/core.md');
  });

  test('a single-target success without either input repeats the resolved target', () => {
    const { completed } = runTool({
      name: 'Bash', input: { command: 'cat notes.txt' }, content: 'alpha\nbeta\n',
    });
    assert.equal(completed.telemetry.pathEvents[0].rawPath, '/repo/notes.txt');
  });
});

// ─── Native input containment ────────────────────────────────────────────────

describe('native input containment', () => {
  test('no returned effect, residual, or telemetry carries a native input member', () => {
    const probe = 'NATIVE-INPUT-PROBE';
    const cases = [
      { name: 'Read', input: { file_path: '/repo/a.js', probe }, content: READ_FULL },
      { name: 'Edit', input: { file_path: '/repo/a.js', old_string: probe, new_string: 'x' }, content: 'ok' },
      { name: 'Bash', input: { command: 'npm test', probe }, content: 'out' },
      { name: 'mcp__serena__onboarding', input: { probe }, content: 'out' },
      { name: 'Skill', input: { skill: 'brainstorming', probe }, content: 'Launching skill: brainstorming' },
    ];
    for (const kase of cases) {
      const { started, completed } = runTool(kase);
      const returned = JSON.stringify({
        startedEffects: started.effects, startedResiduals: started.residuals, startedTelemetry: started.telemetry,
        effects: completed.effects, residuals: completed.residuals, telemetry: completed.telemetry,
        skillContinuation: completed.skillContinuation,
      });
      assert.ok(!returned.includes(probe), `${kase.name}: ${returned}`);
    }
  });

  test('the Projection-local correlation may retain native input', () => {
    const probe = 'NATIVE-INPUT-PROBE';
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: '/repo/a.js', probe } }),
      makeContext(),
    );
    assert.ok(JSON.stringify(started.pending).includes(probe));
  });
});

// ─── Load and handoff token telemetry ────────────────────────────────────────

describe('load token telemetry', () => {
  const LOAD = 'mcp__plugin_session-watcher_session-watcher__load_handoff';

  test('an explicit load token is read off the tool use', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: LOAD, input: { load_token: 'amber-otter' } }),
      makeContext(),
    );
    assert.equal(started.telemetry.loadToken, 'amber-otter');
  });

  test('an auto-matched load resolves its token from the result', () => {
    const { started, completed } = runTool({
      name: LOAD, input: {}, content: JSON.stringify({ load_token: 'amber-otter', summary: 'x' }),
    });
    assert.equal(started.telemetry.loadToken, null);
    assert.equal(completed.telemetry.loadToken, 'amber-otter');
  });

  test('a non-JSON auto-match result leaves the token unresolved', () => {
    const { completed } = runTool({ name: LOAD, input: {}, content: 'not json at all' });
    assert.equal(completed.telemetry.loadToken, null);
  });

  test('an ordinary tool carries no load token', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: '/repo/a.js' } }),
      makeContext(),
    );
    assert.equal(started.telemetry.loadToken, null);
  });
});

// ─── Tool result text normalization ──────────────────────────────────────────

describe('tool result text', () => {
  test('an array of parts joins its text blocks and drops the rest', () => {
    const { completed } = runTool({
      name: 'Read', input: { file_path: '/repo/a.js' },
      content: [
        { type: 'text', text: '1\tconst a = 1;' },
        { type: 'image', source: {} },
        { type: 'text', text: '2\tconst b = 2;' },
      ],
    });
    assertWholeContent(onlyImpact(onlyEffect(completed)), '1\tconst a = 1;', '2\tconst b = 2;');
  });

  test('an unreadable content shape reads as no text', () => {
    const { completed } = runTool({ name: 'Read', input: { file_path: '/repo/a.js' }, content: { unexpected: true } });
    assert.deepEqual(completed.effects, []);
  });

  test('a result carrying no content is not effective', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: '/repo/a.js' } }),
      makeContext(),
    );
    const completed = completeClaudeCodeToolResult(
      started.pending,
      { type: 'tool-result', toolUseId: 'tu1' },
      makeContext(),
    );
    assert.deepEqual(completed.effects, []);
    assert.deepEqual(completed.residuals, []);
  });
});

// ─── Issuing step policy ─────────────────────────────────────────────────────

describe('issuing step policy', () => {
  test('a tool use derives its issuing step and policy from its own row', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: '/repo/a.js' }, messageId: 'cc:row:12', model: 'deepseek-v4-pro' }),
      makeContext(),
    );
    assert.equal(started.pending.issuingStepId, 'cc:row:12');
    assert.deepEqual(started.pending.issuingPolicy, modelPolicyFor('deepseek-v4-pro'));
    assert.equal(started.telemetry.issuingStepId, 'cc:row:12');
  });

  test('an absent row model resolves the fallback policy', () => {
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: '/repo/a.js' }, model: null }),
      makeContext(),
    );
    assert.deepEqual(started.pending.issuingPolicy, modelPolicyFor(null));
  });

  test('the result is priced under the issuing policy the tool use froze', () => {
    const claude = runTool({ name: 'Read', input: { file_path: '/repo/a.js' }, content: '1\t' + '好'.repeat(200) + '\n2\tx\n' });
    const started = interpretClaudeCodeToolUse(
      useObservation({ name: 'Read', input: { file_path: '/repo/a.js' }, model: 'gpt-5' }),
      makeContext(),
    );
    const fallback = completeClaudeCodeToolResult(
      started.pending,
      resultObservation({ content: '1\t' + '好'.repeat(200) + '\n2\tx\n' }),
      makeContext(),
    );
    assert.notEqual(
      onlyImpact(onlyEffect(claude.completed)).mutation.fragments[0].tokens,
      onlyImpact(onlyEffect(fallback)).mutation.fragments[0].tokens,
    );
  });
});

// ─── classifyToolPair ────────────────────────────────────────────────────────

describe('classifyToolPair', () => {
  const CASES = [
    [{ name: 'Read', input: { file_path: '/repo/a.js' }, result: READ_FULL, resourceKey: '/repo/a.js' }, 'path'],
    [{ name: 'Read', input: { file_path: '/repo/a.js' }, result: READ_FULL, isError: true, resourceKey: '/repo/a.js' }, 'residual'],
    [{ name: 'Read', input: { file_path: '/repo/a.js' }, result: 'file not found', resourceKey: '/repo/a.js' }, 'residual'],
    [{ name: 'Read', input: { file_path: '/repo/a.js' }, result: null, resourceKey: '/repo/a.js' }, 'residual'],
    [{ name: 'Bash', input: { command: 'npm test' }, result: 'passed', resourceKey: null }, 'residual'],
    [{ name: 'Bash', input: { command: 'cat notes.txt' }, result: 'alpha\nbeta\n', resourceKey: '/repo/notes.txt' }, 'path'],
    [{ name: 'Grep', input: { pattern: 'x' }, result: 'src/a.js:1:x\n', resourceKey: null }, 'path'],
    [{ name: 'Grep', input: { pattern: 'x' }, result: 'No matches found', resourceKey: null }, 'residual'],
    [{ name: 'Skill', input: { skill: 'brainstorming' }, result: 'Launching skill', resourceKey: 'skill:brainstorming' }, 'skill'],
    [{ name: 'WebFetch', input: { url: 'https://x' }, result: 'html', resourceKey: null }, 'residual'],
    [{ name: 'Write', input: { file_path: '/repo/a.js', content: 'x' }, result: 'ok', resourceKey: '/repo/a.js' }, 'path'],
    [{ name: 'Edit', input: { file_path: '/repo/a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }, result: 'The file /repo/a.js has been updated.', resourceKey: '/repo/a.js' }, 'path'],
  ];
  for (const [pair, expected] of CASES) {
    test(`${pair.name} classifies as ${expected}`, () => {
      assert.equal(classifyToolPair(pair, CLAUDE_CTP), expected);
    });
  }

  test('it consumes the pre-resolved target instead of resolving one', () => {
    const pair = { name: 'Read', input: { file_path: 'a.js' }, result: READ_FULL, resourceKey: null };
    assert.equal(classifyToolPair(pair, CLAUDE_CTP), 'residual', 'an unresolved target has no resident content');
    assert.equal(classifyToolPair({ ...pair, resourceKey: '/anywhere/a.js' }, CLAUDE_CTP), 'path');
  });

  test('the classification is independent of the CTP pair supplied', () => {
    const pair = { name: 'Read', input: { file_path: '/repo/a.js' }, result: READ_FULL, resourceKey: '/repo/a.js' };
    for (const ctp of [CLAUDE_CTP, modelPolicyFor('deepseek-v4-pro').ctp, modelPolicyFor('gpt-5').ctp]) {
      assert.equal(classifyToolPair(pair, ctp), 'path', JSON.stringify(ctp));
    }
  });

  test('an array-of-parts result is read as text', () => {
    const pair = {
      name: 'Read', input: { file_path: '/repo/a.js' }, resourceKey: '/repo/a.js',
      result: [{ type: 'text', text: '1\tconst a = 1;' }, { type: 'text', text: '2\tconst b = 2;' }],
    };
    assert.equal(classifyToolPair(pair, CLAUDE_CTP), 'path');
  });

  // Every result-named file arrives as a dictionary key, and a filename is arbitrary data. The
  // referencing fixture is authored as the tool's own JSON text because a JSON member named
  // `__proto__` parses to an own property while an object literal written with that key sets the
  // prototype, which would change the input before any adapter saw it.
  const RESULT_NAMED_ADAPTERS = [
    ['Grep', name => ({
      name: 'Grep', input: { pattern: 'needle', output_mode: 'content', '-n': true },
      result: `${name}:1:needle here\n${name}:2:needle again\n`, resourceKey: null,
    })],
    ['a project-wide find_symbol', name => ({
      name: 'mcp__serena__find_symbol', input: { name_path: 'f' },
      result: SERENA_OK([{ relative_path: name, body_location: { start_line: 0 }, body: 'const x = 1;' }]),
      resourceKey: null,
    })],
    ['find_referencing_symbols', name => ({
      name: 'mcp__serena__find_referencing_symbols', input: { name_path: 'f' },
      result: SERENA_OK(`{"${name}":{"function":[{"body_location":{"start_line":9},`
        + '"content_around_reference":"  callIt();\\n  more();"}]}}'),
      resourceKey: null,
    })],
  ];
  for (const [label, build] of RESULT_NAMED_ADAPTERS) {
    for (const filename of ['__proto__', 'toString', 'constructor', 'ordinary.js']) {
      test(`${label} classifies a file named ${filename} as a path`, () => {
        assert.equal(classifyToolPair(build(filename), CLAUDE_CTP), 'path');
      });
    }
  }
});

// ─── Turn History evidence admission ─────────────────────────────────────────
// The predicate shared Turn History injects is this classifier read for one answer: residual evidence
// exists only in the Source and is searchable there, while a pair whose ground truth is the working tree
// is reachable at full length and stays out of the corpus (ADR 0004). `resourceKey` is not the criterion.

describe('the injected search-evidence predicate', () => {
  const includeToolEvidence = (pair) => classifyToolPair(pair, CLAUDE_CTP) === 'residual';

  test('a failed Read is residual, has a resourceKey, and remains included', () => {
    const pair = {
      name: 'Read', input: { file_path: '/repo/a.js' }, result: 'Error: file not found',
      isError: true, resourceKey: '/repo/a.js',
    };
    assert.equal(classifyToolPair(pair, CLAUDE_CTP), 'residual');
    assert.equal(pair.resourceKey, '/repo/a.js', 'a resolved key does not decide admission');
    assert.equal(includeToolEvidence(pair), true);
  });

  test('a successful multi-file Grep is path, has no single resourceKey, and remains excluded', () => {
    const pair = {
      name: 'Grep', input: { pattern: 'needle', output_mode: 'content', '-n': true },
      result: 'src/a.js:1:needle here\nsrc/b.js:4:needle there\n', resourceKey: null,
    };
    assert.equal(classifyToolPair(pair, CLAUDE_CTP), 'path');
    assert.equal(pair.resourceKey, null, 'an absent key does not decide admission either');
    assert.equal(includeToolEvidence(pair), false);
  });
});
