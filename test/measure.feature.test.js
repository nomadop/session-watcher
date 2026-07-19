// test/measure.feature.test.js — TDD tests for bashFeature, mcpDisplay, redactCmd (Task 0b)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bashFeature, mcpDisplay, redactCmd } from '../lib/measure.js';
import { redactCmd as redactCmdFrontend } from '../public/lib/redaction.js';

// ─── redactCmd ───────────────────────────────────────────────────────────────

describe('redactCmd', () => {
  test('masks AWS_SECRET=abc123', () => {
    const out = redactCmd('AWS_SECRET=abc123 npm run');
    assert.ok(out.includes('AWS_SECRET=***'), `expected AWS_SECRET=***, got: ${out}`);
    assert.ok(!out.includes('abc123'), `secret leaked: ${out}`);
  });

  test('masks API_TOKEN=xyz', () => {
    const out = redactCmd('API_TOKEN=xyz curl');
    assert.ok(out.includes('API_TOKEN=***'), `expected API_TOKEN=***, got: ${out}`);
    assert.ok(!out.includes('xyz'), `secret leaked: ${out}`);
  });

  test('replaces /home/alice path with ~', () => {
    const out = redactCmd('cat /home/alice/.ssh/id');
    assert.ok(out.includes('~'), `expected ~ in: ${out}`);
  });

  test('replaces /root path with ~', () => {
    const out = redactCmd('cat /root/data');
    assert.ok(out.includes('~'), `expected ~ in: ${out}`);
  });

  test('masks user@ip pattern', () => {
    const out = redactCmd('scp user@10.0.0.1:/x .');
    assert.ok(out.includes('***@<ip>'), `expected ***@<ip> in: ${out}`);
  });

  test('masks --token value', () => {
    const out = redactCmd('--token abc123');
    assert.ok(out.includes('--token ***'), `expected --token ***, got: ${out}`);
  });

  test('masks Bearer token', () => {
    const out = redactCmd('Bearer eyJhbGc...');
    assert.ok(out.includes('Bearer ***'), `expected Bearer ***, got: ${out}`);
  });

  test('masks https://user:pass@host', () => {
    const out = redactCmd('https://admin:s3cr3t@api.example.com');
    assert.ok(out.includes('***:***@'), `expected ***:***@ in: ${out}`);
  });

  test('leaves clean command unchanged: npm test', () => {
    assert.equal(redactCmd('npm test'), 'npm test');
  });

  test('leaves clean command unchanged: git log --oneline', () => {
    assert.equal(redactCmd('git log --oneline'), 'git log --oneline');
  });
});

// ─── redactCmd frontend/backend parity ───────────────────────────────────────

describe('redactCmd frontend/backend parity', () => {
  const cases = [
    'AWS_SECRET=abc123 npm run',
    'API_TOKEN=xyz curl',
    'cat /home/alice/.ssh/id',
    'cat /root/data',
    'scp user@10.0.0.1:/x .',
    '--token abc123',
    'Bearer eyJhbGc...',
    'https://admin:s3cr3t@api.example.com',
    'npm test',
    'git log --oneline',
  ];
  for (const cmd of cases) {
    test(`identical output for: ${cmd.slice(0, 40)}`, () => {
      assert.equal(redactCmd(cmd), redactCmdFrontend(cmd));
    });
  }
});

// ─── mcpDisplay ──────────────────────────────────────────────────────────────

describe('mcpDisplay', () => {
  test('serena find_symbol', () => {
    assert.equal(mcpDisplay('mcp__serena__find_symbol'), 'serena find_symbol');
  });

  test('playwright browser_evaluate', () => {
    assert.equal(mcpDisplay('mcp__plugin_playwright_playwright__browser_evaluate'), 'playwright browser_evaluate');
  });

  test('session-watcher start_watcher', () => {
    assert.equal(mcpDisplay('mcp__plugin_session-watcher_session-watcher__start_watcher'), 'session-watcher start_watcher');
  });

  test('passthrough for non-MCP tool names', () => {
    assert.equal(mcpDisplay('Read'), 'Read');
  });
});

// ─── bashFeature ─────────────────────────────────────────────────────────────

describe('bashFeature', () => {
  test('git log --oneline -20 → name: git log', () => {
    const r = bashFeature('git log --oneline -20');
    assert.equal(r.name, 'git log');
  });

  test('cd /workspace && npm test → name: npm test (cd preamble stripped)', () => {
    const r = bashFeature('cd /workspace && npm test');
    assert.equal(r.name, 'npm test');
  });

  test('fn22 && pnpm test:client → name: pnpm test:client (fn preamble stripped)', () => {
    const r = bashFeature('fn22 && pnpm test:client');
    assert.equal(r.name, 'pnpm test:client');
  });

  test('FOO=bar BAZ=1 curl https://api.example.com/v1 → name: curl, detail: api.example.com', () => {
    const r = bashFeature('FOO=bar BAZ=1 curl https://api.example.com/v1');
    assert.equal(r.name, 'curl');
    assert.equal(r.detail, 'api.example.com');
  });

  test('git -C /some/path log → name: git log (skip -C flag+arg)', () => {
    const r = bashFeature('git -C /some/path log');
    assert.equal(r.name, 'git log');
  });

  test('bash scripts/deploy.sh → name: bash deploy.sh', () => {
    const r = bashFeature('bash scripts/deploy.sh');
    assert.equal(r.name, 'bash deploy.sh');
  });

  test('python3 << "EOF"\\nprint("hi")\\nEOF → name: python3', () => {
    const r = bashFeature('python3 << "EOF"\nprint("hi")\nEOF');
    assert.equal(r.name, 'python3');
  });

  test('node -e "console.log(1)" → name: node', () => {
    const r = bashFeature('node -e "console.log(1)"');
    assert.equal(r.name, 'node');
  });

  test('sudo docker compose up → name: docker compose (sudo stripped)', () => {
    const r = bashFeature('sudo docker compose up');
    assert.equal(r.name, 'docker compose');
  });

  test('cat /home/alice/foo | grep bar → name: cat (first stage only)', () => {
    const r = bashFeature('cat /home/alice/foo | grep bar');
    assert.equal(r.name, 'cat');
  });

  test('AWS_SECRET=abc123 npm run deploy → name: npm run (env stripped, secret never in name)', () => {
    const r = bashFeature('AWS_SECRET=abc123 npm run deploy');
    assert.equal(r.name, 'npm run');
    assert.ok(!r.name.includes('abc123'));
    assert.ok(!r.detail.includes('abc123'));
  });

  test('/usr/local/bin/custom-tool → name: (script) (path with / → fallback)', () => {
    const r = bashFeature('/usr/local/bin/custom-tool');
    assert.equal(r.name, '(script)');
  });

  test('source ~/.bashrc; git status → name: git status (source preamble stripped)', () => {
    const r = bashFeature('source ~/.bashrc; git status');
    assert.equal(r.name, 'git status');
  });

  test('empty/null command → { name: (bash), detail: "" }', () => {
    assert.deepEqual(bashFeature(''), { name: '(bash)', detail: '' });
    assert.deepEqual(bashFeature(null), { name: '(bash)', detail: '' });
    assert.deepEqual(bashFeature(undefined), { name: '(bash)', detail: '' });
  });

  test('bashFeature: nested wrappers stripped (sudo env docker)', () => {
    const r = bashFeature('sudo env docker compose up');
    assert.equal(r.name, 'docker compose');
  });

  test('bashFeature: triple wrapper (time sudo nohup curl)', () => {
    const r = bashFeature('time sudo nohup curl https://example.com');
    assert.equal(r.name, 'curl');
  });

  test('name and detail capped to 40 chars', () => {
    const longCmd = 'git ' + 'a'.repeat(60);
    const r = bashFeature(longCmd);
    assert.ok(r.name.length <= 40, `name too long: ${r.name.length}`);
    assert.ok(r.detail.length <= 40, `detail too long: ${r.detail.length}`);
  });

  test('leading comment line stripped: "# desc\\ngit status" → git status', () => {
    const r = bashFeature('# Check the file status\ngit status');
    assert.equal(r.name, 'git status');
  });

  test('multiple leading comment lines stripped', () => {
    const r = bashFeature('# First comment\n# Second comment\ngit log --oneline');
    assert.equal(r.name, 'git log');
  });

  test('comment-only command (no actual cmd) → (bash)', () => {
    assert.deepEqual(bashFeature('# just a comment'), { name: '(bash)', detail: '' });
    assert.deepEqual(bashFeature('# line1\n# line2'), { name: '(bash)', detail: '' });
  });

  test('inline # in args NOT stripped: echo hello # world', () => {
    const r = bashFeature('echo hello # world');
    assert.equal(r.name, 'echo');
    assert.equal(r.detail, 'hello');
  });

  test('CRLF comment line stripped: "# desc\\r\\ngit status" → git status', () => {
    const r = bashFeature('# Install deps\r\nnpm install');
    assert.equal(r.name, 'npm install');
  });

  test('VAR=val + comment + command: comment stripped after env prefix removal', () => {
    const r = bashFeature('BASE=/some/path\n# comment about what this does\ncat file.jsonl');
    assert.equal(r.name, 'cat');
    assert.equal(r.detail, 'file.jsonl');
  });

  test('VAR=val + multi-comment + command', () => {
    const r = bashFeature('C=abc123\n# Build a seed\n# another comment\ndocker cp foo bar');
    assert.equal(r.name, 'docker cp');
  });
});
