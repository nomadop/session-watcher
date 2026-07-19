import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactCmd, buildCompactInstruction } from '../public/elements/bucketPanel.js';

test('redactCmd: masks secrets, home dirs, user@ip', () => {
  assert.match(redactCmd('AWS_SECRET=abc123 npm run'), /AWS_SECRET=\*\*\*/);
  assert.match(redactCmd('API_TOKEN=xyz'), /API_TOKEN=\*\*\*/);
  assert.match(redactCmd('cat /home/alice/.ssh/id'), /~\/\.ssh\/id/);
  assert.match(redactCmd('scp user@10.0.0.1:/x .'), /\*\*\*@<ip>/);
});

test('redactCmd: leaves ordinary commands unchanged', () => {
  assert.equal(redactCmd('npm test'), 'npm test');
});

test('buildCompactInstruction: retain kept paths, discard unchecked bash', () => {
  const tree = [
    { kind: 'dir', group: 'paths', name: 'src/auth/', selectable: true, children: [
      { kind: 'file', group: 'paths', name: 'index.js', selected: true, selectable: true, children: null },
      { kind: 'file', group: 'paths', name: 'middleware.js', selected: true, selectable: true, children: null },
    ] },
    { kind: 'bash', group: 'output', name: 'npm test', id: 'bash:npm test', detail: '', selected: false, selectable: true, children: null },
    // leaf.name IS the server-extracted feature (Task 0b) — compact/redaction operate on it
    { kind: 'others', group: 'output', locked: true, tokens: 100, children: null },
  ];
  const s = buildCompactInstruction(tree);
  assert.match(s, /^\/compact /);
  assert.match(s, /retain detailed context for/);
  assert.match(s, /src\/auth\//);
  assert.match(s, /discard/);
  assert.match(s, /npm test/);
});

test('buildCompactInstruction: half-selected dir → summarize excluding unchecked child', () => {
  const tree = [
    { kind: 'dir', group: 'paths', name: 'lib/', selectable: true, children: [
      { kind: 'file', group: 'paths', name: 'watcher.js', selected: true, selectable: true, children: null },
      { kind: 'file', group: 'paths', name: 'constants.js', selected: false, selectable: true, children: null },
    ] },
  ];
  const s = buildCompactInstruction(tree);
  assert.match(s, /summarize lib\/ briefly/);
  assert.match(s, /excluding.*constants\.js/);
});

test('buildCompactInstruction: bash feature is re-redacted at the clipboard sink (defense-in-depth)', () => {
  // Server extraction already dropped args, but if a secret ever reaches leaf.name, redactCmd catches it.
  const tree = [
    { kind: 'bash', group: 'output', name: 'AWS_SECRET=zzz aws s3 cp', id: 'bash:x', detail: '', selected: false, selectable: true, children: null },
  ];
  const s = buildCompactInstruction(tree);
  assert.match(s, /AWS_SECRET=\*\*\*/);
  assert.doesNotMatch(s, /zzz/);
});

test('buildCompactInstruction: path names are redacted (home dir scrubbing — external review GPT#10)', () => {
  const tree = [
    { kind: 'file', group: 'paths', name: '/home/alice/project/src/app.js', selected: true, selectable: true, children: null },
  ];
  const s = buildCompactInstruction(tree);
  assert.doesNotMatch(s, /alice/, 'home dir username redacted from clipboard');
  assert.match(s, /~/, 'replaced with ~');
});

test('buildCompactInstruction: bash detail included for disambiguation (external review GPT#10)', () => {
  const tree = [
    { kind: 'bash', group: 'output', name: 'curl', detail: 'api.example.com', id: 'bash:curl', selected: false, selectable: true, children: null },
  ];
  const s = buildCompactInstruction(tree);
  assert.match(s, /curl api\.example\.com/, 'detail appended for disambiguation');
});

test('buildCompactInstruction: nested half-selected dir summarizes with excluded descendant (review GPT#6)', () => {
  const tree = [
    { kind: 'dir', group: 'paths', name: 'packages/core/src/', selectable: true, children: [
      { kind: 'dir', group: 'paths', name: 'auth/', selectable: true, children: [
        { kind: 'file', group: 'paths', name: 'index.ts', selected: true, selectable: true, children: null },
        { kind: 'file', group: 'paths', name: 'secret.ts', selected: false, selectable: true, children: null },
      ] },
    ] },
  ];
  const s = buildCompactInstruction(tree);
  // The half-selected NESTED dir must be summarized with its unchecked child excluded — a top-level-only
  // walk would miss it entirely.
  assert.match(s, /summarize .*auth\/ briefly/);
  assert.match(s, /excluding.*secret\.ts/);
});
