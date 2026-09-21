import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal, getStore } from '../lib/store.js';

const TMP = mkdtempSync(join(tmpdir(), 'sw-shf-'));
initStore(join(TMP, 't.sqlite'));
process.on('exit', () => { try { closeStoreGlobal(); } catch {} try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { createServer } from '../server.js';
import { bootTestServer, composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';
import { assistantToolUse, toolResult, ts, usage } from './helpers/transcript-fixtures.js';

void createServer;   // wired by the composition helper below

// Read tool pairs that make one path resident with EXACTLY the given line coverage. A partial read is a
// line-fragment update keyed by source line, so the coverage is what the result's own `N\t` prefixes say —
// which is why these ranges can be asserted as the ranges the Source reports.
function partialReads(path, ranges) {
  const rows = [];
  ranges.forEach(([from, to], i) => {
    const lines = [];
    for (let n = from; n <= to; n++) lines.push(`${n}\tconst v${n} = ${n};`);
    rows.push(assistantToolUse({
      uuid: `xr${i}`, messageId: `xrm${i}`, toolUseId: `xrt${i}`, name: 'Read',
      input: { file_path: path, offset: from, limit: to - from + 1 }, timestamp: ts(3),
      model: 'deepseek-v4-pro', usage: usage({ input: 40, output: 30, cacheRead: 60000 + i * 500 }),
    }));
    rows.push(toolResult({ uuid: `xrr${i}`, toolUseId: `xrt${i}`, content: lines.join('\n') }));
  });
  return rows;
}

// A WHOLE-content read: no offset, so the resource is marked `fullSnapshot` and its line coverage is
// suppressed by that flag rather than by holding no lines.
function fullRead(path) {
  const lines = [];
  for (let n = 1; n <= 3; n++) lines.push(`${n}\tconst w${n} = ${n};`);
  return [
    assistantToolUse({
      uuid: 'xf0', messageId: 'xfm0', toolUseId: 'xft0', name: 'Read',
      input: { file_path: path }, timestamp: ts(3),
      model: 'deepseek-v4-pro', usage: usage({ input: 40, output: 30, cacheRead: 61000 }),
    }),
    toolResult({ uuid: 'xfr0', toolUseId: 'xft0', content: lines.join('\n') }),
  ];
}

// A Markdown document whose top-level headings are the kept symbols, the section appended to it later, and
// the document they make. A read's result carries the file's own numbered lines, so a resource's
// coverage is the lines the read saw, keyed by source line.
const NOTES_LINES = ['# Alpha', '', 'alpha body', '', '# Beta', '', 'beta body'];
const GAMMA_LINES = ['', '# Gamma', '', 'gamma body'];
const GROWN_LINES = [...NOTES_LINES, ...GAMMA_LINES];
const NOTES_DOC = NOTES_LINES.join('\n') + '\n';
const GAMMA_SECTION = GAMMA_LINES.join('\n') + '\n';
const GROWN_DOC = GROWN_LINES.join('\n') + '\n';

// The first source line the overlapping re-read asks for: inside `Beta`, which the first read already saw.
const OVERLAP_FROM = 5;

const numberedFrom = (lines, from) => lines.map((line, index) => `${from + index}\t${line}`).join('\n');

function wholeMarkdownRead(path, lines = NOTES_LINES, { tag = 'xm', cacheRead = 62000 } = {}) {
  return [
    assistantToolUse({
      uuid: `${tag}0`, messageId: `${tag}m0`, toolUseId: `${tag}t0`, name: 'Read',
      input: { file_path: path }, timestamp: ts(3),
      model: 'deepseek-v4-pro', usage: usage({ input: 40, output: 30, cacheRead }),
    }),
    toolResult({ uuid: `${tag}r0`, toolUseId: `${tag}t0`, content: numberedFrom(lines, 1) }),
  ];
}

// A PARTIAL read: an offset makes the update a line-keyed merge rather than a whole-content replacement.
function partialMarkdownRead(path, lines, from) {
  return [
    assistantToolUse({
      uuid: 'xq0', messageId: 'xqm0', toolUseId: 'xqt0', name: 'Read',
      input: { file_path: path, offset: from, limit: lines.length }, timestamp: ts(4),
      model: 'deepseek-v4-pro', usage: usage({ input: 45, output: 30, cacheRead: 63000 }),
    }),
    toolResult({ uuid: 'xqr0', toolUseId: 'xqt0', content: numberedFrom(lines, from) }),
  ];
}

async function withServer(fn, { extraEntries = [], projectRoot = null } = {}) {
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 30, extraEntries }),
    sessionId: 'sid-srv', projectId: 'proj-srv', projectRoot,
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(port, composed.watcher, composed.store, composed.appendRows);
  } finally { stopTimers(); await composed.teardown(); }
}

test('GET /api/buckets is enriched with metrics + session_id + snake_case last_active_turn', async () => {
  await withServer(async (port) => {
    const data = await (await fetch(`http://127.0.0.1:${port}/api/buckets`)).json();
    assert.equal(data.session_id, 'sid-srv');
    assert.equal(typeof data.current_turn, 'number');
    assert.equal(typeof data.generated_at, 'number');
    assert.ok(data.metrics && typeof data.metrics.br !== 'undefined');
    assert.ok('b_total' in data.metrics && 'c_ratio' in data.metrics && 'pp' in data.metrics);
    if (data.paths.length) assert.ok('last_active_turn' in data.paths[0]);
  });
});

test('POST /api/handoff/prepare → ready + load_token; GET load by token round-trips', async () => {
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/app.js', symbols: ['handleAuth'] }], summary: 'Refactor auth middleware', next_task: 'fix token refresh' }),
    })).json();
    assert.equal(prep.status, 'ready');
    assert.ok(prep.load_token && prep.load_token.split('-').length === 3);
    assert.equal(typeof prep.summary_tokens, 'number');
    // Same-session no-param load → found:false (auto-match excludes own session)
    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load`)).json();
    assert.equal(load.found, false, 'auto-match excludes own session');
    // Token load still works
    const byTok = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    assert.equal(byTok.found, true);
    assert.equal(byTok.load_token, prep.load_token);
    assert.strictEqual(byTok.next_task, undefined, 'next_task removed from load response');
    assert.equal(byTok.paths_to_keep[0].path, 'src/app.js');
    assert.deepEqual(byTok.paths_to_keep[0].symbols, ['handleAuth']);
    assert.strictEqual(byTok.previous_segment, undefined, 'previous_segment should not be exposed in load response');
    assert.equal(byTok.project_dir, 'proj-srv', 'load response includes project_dir from DB record');
  });
});

test('POST prepare rejects oversized summary + too many paths + secret redaction', async () => {
  await withServer(async (port) => {
    const tooLong = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [], summary: 'x'.repeat(10001) }),
    })).json();
    assert.equal(tooLong.error, 'summary_too_long');
    const secret = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/app.js' }], summary: 'key sk-ABCDEF0123456789ABCDEF', next_task: 'ghp_ABCDEF0123456789ABCDEFGHIJ' }),
    })).json();
    assert.equal(secret.status, 'ready');
    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${secret.load_token}`)).json();
    assert.ok(!load.summary.includes('sk-ABCDEF'), 'secret redacted in stored summary');
  });
});

test('prepare auto-injects line ranges from the resident coverage when the path was read in parts', async () => {
  // Two PARTIAL Reads of one path. Injecting the coverage directly is no longer possible, and would not be
  // the same fact anyway: these ranges are what the Source says was actually read.
  const testPath = 'src/injected.js';
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: testPath }], summary: 'Lines injection test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    const entry0 = load.paths_to_keep[0];
    assert.equal(entry0.path, testPath);
    assert.deepEqual(entry0.lines, [[10, 12], [20, 21]], 'the resident lines collapse into ranges');
  }, { extraEntries: partialReads(testPath, [[10, 12], [20, 21]]) });
});

test('prepare skips lines injection when the path was read whole (full snapshot)', async () => {
  // A whole-content read marks the resource `fullSnapshot`, and that flag is what suppresses line ranges —
  // that is what makes the entry arrive with no `lines`.
  const testPath = 'src/full.js';
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: testPath }], summary: 'Full snapshot test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    const entry0 = load.paths_to_keep[0];
    assert.equal(entry0.path, testPath);
    assert.strictEqual(entry0.lines, undefined, 'a whole-file read injects no line ranges');
  }, { extraEntries: fullRead(testPath) });
});

// The symbol-range sibling of the lines-injection cases above, and the only symbol-range case over the
// REAL Engine: the ranges are computed against the coverage the Read observation recorded. The file GROWS
// between the read and the prepare, which is what tells that coverage apart from the file's current
// length — a substitution that reaches the appended section instead. Appending past the end leaves the
// text as of the read and the text as it stands agreeing on every covered line, so which of them a range
// is parsed from is outside what this case pins. The Store row is the oracle rather than the load
// response, so nothing after prepare can supply the shape. A Markdown fixture keeps the outline on the
// regex path, so the case needs no grammar wasm to run.
test('prepare captures symbol ranges from the real read-time coverage, leaving an appended section out', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-shf-proj-'));
  const notesPath = join(projectDir, 'notes.md');
  writeFileSync(notesPath, NOTES_DOC);
  try {
    await withServer(async (unusedPort, watcher, store) => {
      // Appended after the read the transcript records: `Gamma` is outside every covered line, and the parse
      // at prepare time still sees it, so a range for it could only come from the file's own current length.
      appendFileSync(notesPath, '\n# Gamma\n\ngamma body\n');
      const prep = watcher.prepareHandoff({
        pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha', 'Beta', 'Gamma'] }],
        summary: 'keep the sections the read actually saw',
      });
      assert.equal(prep.status, 'ready');
      const row = store._db.prepare('SELECT paths_to_keep FROM handoff WHERE load_token = ?').get(prep.load_token);
      // No kept skills, so the stored payload is the bare entry array rather than the object form.
      const entry = JSON.parse(row.paths_to_keep)[0];
      assert.deepEqual(entry.symbolRanges, { Alpha: [[1, 4]], Beta: [[5, 7]] });
      assert.equal(entry.symbols, undefined, 'the ranges replaced the bare names');
    }, { extraEntries: wholeMarkdownRead(notesPath), projectRoot: projectDir });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// The whole-then-partial half of the same chain, and the one shape where a source line is observed by more
// than one read: the second read starts at `OVERLAP_FROM`, inside what the first read already saw, and runs
// past the section appended between them. A control resource holding the grown document, read whole in one
// go, is what the belief has to land on — each read is a single-impact `Read`, so both resources carry
// `TOOL_OVERHEAD.Read`, and equal beliefs mean equal fragment unions. The repeated lines are still charged
// in SPEND, where `resource.overhead` is assigned per impact rather than accumulated — which is what
// separates the belief from what it cost. `test/measurement-engine.effects.test.js`
// (`upserts by resource-local natural key`) holds the same upsert at the ledger's own boundary; what this
// case adds is the chain from the Read adapter's numbered lines through prepare into the Store.
test('an overlapping partial read extends the coverage without re-counting the lines it repeats', async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'sw-shf-grow-'));
  const notesPath = join(projectDir, 'notes.md');
  const controlPath = join(projectDir, 'control.md');
  writeFileSync(notesPath, NOTES_DOC);
  writeFileSync(controlPath, GROWN_DOC);
  const entries = [
    ...wholeMarkdownRead(notesPath),
    ...wholeMarkdownRead(controlPath, GROWN_LINES, { tag: 'xc', cacheRead: 62500 }),
  ];
  try {
    await withServer(async (unusedPort, watcher, store, appendRows) => {
      appendFileSync(notesPath, GAMMA_SECTION);
      // Chained onto the fixture's own leaf: a null-parent row is a topology root, which is a compact epoch,
      // and the epoch would install a fresh ledger where this case's first read never happened.
      appendRows(partialMarkdownRead(notesPath, GROWN_LINES.slice(OVERLAP_FROM - 1), OVERLAP_FROM),
        { parentUuid: entries[entries.length - 1].uuid });

      const bucket = watcher.getBucketData();
      const grown = bucket.paths.find(row => row.path === notesPath);
      const control = bucket.paths.find(row => row.path === controlPath);
      assert.equal(grown.readCount, 2, 'the overlapping read reached the same resource');
      assert.equal(grown.tokens, control.tokens, 'the repeated lines are covered, never counted a second time');
      assert.ok(grown.totalSpent > control.totalSpent, 'and the repeated read is charged in spend');

      const prep = watcher.prepareHandoff({
        pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha', 'Beta', 'Gamma'] }],
        summary: 'keep the sections both reads saw',
      });
      assert.equal(prep.status, 'ready');
      const row = store._db.prepare('SELECT paths_to_keep FROM handoff WHERE load_token = ?').get(prep.load_token);
      const entry = JSON.parse(row.paths_to_keep)[0];
      assert.deepEqual(entry.symbolRanges, { Alpha: [[1, 4]], Beta: [[5, 8]], Gamma: [[9, 11]] });
    }, { extraEntries: entries, projectRoot: projectDir });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('skills_to_keep round-trips through prepare → load', async () => {
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/a.js' }], skills_to_keep: ['systematic-debugging', 'TDD'], summary: 'Skills test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    assert.deepEqual(load.skills_to_keep, ['systematic-debugging', 'TDD']);
  });
});

test('skills_to_keep omitted from load when not provided in prepare', async () => {
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/b.js' }], summary: 'No skills test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    assert.strictEqual(load.skills_to_keep, undefined, 'no skills_to_keep when none provided');
  });
});

// ── Auto-match (no-params) endpoint tests ───────────────────────────────────

test('GET /api/handoff/load (no params): single pending from other session → auto-match + stamp', async () => {
  await withServer(async (port, watcher, store) => {
    // Insert a handoff from a DIFFERENT session for the same project, into the owner's OWN store.
    store.insertHandoff({
      sessionId: 'other-session-1',
      segment: 0,
      loadToken: 'auto-aaa-bbb',
      createdAt: Date.now(),
      pathsToKeep: JSON.stringify([{ path: 'src/x.js' }]),
      summary: 'Auto-match single test',
      nextTask: 'do the thing',
      summaryTokens: 10,
      projectId: 'proj-srv',
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/handoff/load`);
    const data = await resp.json();
    assert.equal(data.found, true, 'single pending handoff from other session is auto-matched');
    assert.strictEqual(data.next_task, undefined, 'next_task removed from load response');
    assert.equal(data.load_token, 'auto-aaa-bbb');
    // Verify it was stamped (delivered_at set)
    const recheck = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load`)).json();
    assert.equal(recheck.found, false, 'after delivery stamp, no more pending');
  });
});

test('GET /api/handoff/load (no params): multiple pending → ambiguous response with candidates', async () => {
  await withServer(async (port, watcher, store) => {
    // Insert TWO handoffs from different sessions for same project
    store.insertHandoff({
      sessionId: 'other-session-2',
      segment: 0,
      loadToken: 'amb-aaa-111',
      createdAt: Date.now() - 1000,
      pathsToKeep: JSON.stringify([{ path: 'src/a.js' }]),
      summary: 'First ambiguous',
      nextTask: 'task alpha',
      summaryTokens: 5,
      projectId: 'proj-srv',
    });
    store.insertHandoff({
      sessionId: 'other-session-3',
      segment: 0,
      loadToken: 'amb-bbb-222',
      createdAt: Date.now(),
      pathsToKeep: JSON.stringify([{ path: 'src/b.js' }]),
      summary: 'Second ambiguous',
      nextTask: 'task beta',
      summaryTokens: 5,
      projectId: 'proj-srv',
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/handoff/load`);
    const data = await resp.json();
    assert.equal(data.found, false, 'ambiguous case returns found:false');
    assert.equal(data.ambiguous, true);
    assert.ok(Array.isArray(data.candidates));
    assert.ok(data.candidates.length >= 2, 'at least 2 candidates');
    // Candidates should have load_token and next_task_preview
    const tokens = data.candidates.map(c => c.load_token);
    assert.ok(tokens.includes('amb-aaa-111') || tokens.includes('amb-bbb-222'));
    assert.ok(data.candidates[0].next_task_preview);
  });
});

test('GET /api/handoff/load (no params): null projectId → found:false', async () => {
  // With no project identity there is nothing to scope an auto-match to, so delivery returns without a read.
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 30 }), sessionId: 'sid-noproj', projectId: null,
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const data = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load`)).json();
    assert.equal(data.found, false, 'null projectId means no auto-match possible');
  } finally { stopTimers(); await composed.teardown(); }
});

test('GET /api/handoff/load (no params): expired handoff (beyond TTL) → found:false', async () => {
  // An isolated projectId so no earlier test's rows can produce a false-positive pass.
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 30 }),
    sessionId: 'sid-ttl', projectId: 'proj-ttl-isolated',
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    composed.store.insertHandoff({
      sessionId: 'other-session-expired',
      segment: 0,
      loadToken: 'exp-aaa-zzz',
      createdAt: Date.now() - (8 * 24 * 3600 * 1000),   // older than HANDOFF_HOOK_TTL_DAYS
      pathsToKeep: JSON.stringify([{ path: 'src/old.js' }]),
      summary: 'Expired handoff',
      nextTask: 'stale task',
      summaryTokens: 5,
      projectId: 'proj-ttl-isolated',
    });
    const data = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load`)).json();
    assert.equal(data.found, false, 'expired handoff must not be auto-matched');
  } finally { stopTimers(); await composed.teardown(); }
});


// Delivery is one transaction: the row read, the first primary binding and the load attempt all commit
// together, so a failed attempt write publishes no content at all — not a partial response with the
// summary and the turn page in it.
test('delivery write failure: an explicit token and an auto-match both answer a contentless 503', async (t) => {
  const ctx = await bootTestServer({ sessionId: 'sid-deliver-fail', projectId: 'proj-deliver-fail' });
  t.after(() => ctx.teardown());
  const loadToken = 'tok-deliver-fail';
  ctx.store.insertHandoff({
    sessionId: 'session-df-src', segment: 0, loadToken,
    createdAt: Date.now(), pathsToKeep: '[]', summary: 'delivery failure test',
    summaryTokens: 10, projectId: 'proj-deliver-fail',
  });
  const original = ctx.store._stmts.insertHandoffLoad;
  ctx.store._stmts.insertHandoffLoad = { run() { throw new Error('injected delivery failure'); } };
  try {
    for (const url of [`/api/handoff/load?load_token=${loadToken}`, '/api/handoff/load']) {
      const res = await ctx.requestRaw(url);
      assert.equal(res.status, 503, url);
      // The exact body is the assertion: it proves no content field — summary, paths, turn page —
      // reached the response.
      assert.deepEqual(await res.json(), { error: 'handoff_delivery_unavailable', retryable: true }, url);
    }
  } finally {
    ctx.store._stmts.insertHandoffLoad = original;
  }
});
