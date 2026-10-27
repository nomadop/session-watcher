import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { bashFeature, redactCmd } from '../lib/bash-feature.js';
import { redactCmd as redactCmdFrontend } from '../public/lib/redaction.js';

describe('bashFeature', () => {
  test('names git subcommands, script wrappers and env prefixes', () => {
    assert.deepEqual(bashFeature('git -C x status'), { name: 'git status', detail: '' });
    assert.deepEqual(bashFeature('env A=1 npm test'), { name: 'npm test', detail: '' });
    assert.deepEqual(bashFeature('./run.sh'), { name: '(script)', detail: '' });
  });

  test('takes the first non-flag argument or a URL host as detail', () => {
    assert.deepEqual(bashFeature('wc -l a.md'), { name: 'wc', detail: 'a.md' });
    assert.deepEqual(bashFeature('curl https://api.example.com/v1'), { name: 'curl', detail: 'api.example.com' });
  });

  test('redacts the detail', () => {
    assert.deepEqual(bashFeature('ssh alice@10.0.0.1'), { name: 'ssh', detail: '***@<ip>' });
  });

  test('names the consuming stage of a transforming pipe', () => {
    assert.deepEqual(bashFeature('cat notes.txt | python3'), { name: 'python3', detail: 'notes.txt' });
    assert.deepEqual(bashFeature('cat notes.txt | head'), { name: 'cat', detail: 'notes.txt' });
  });
});

describe('bash residual naming', () => {
  const CASES = [
    ['git log --oneline -20', 'git log', ''],
    ['cd /workspace && npm test', 'npm test', ''],
    ['fn22 && pnpm test:client', 'pnpm test:client', ''],
    ['FOO=bar BAZ=1 curl https://api.example.com/v1', 'curl', 'api.example.com'],
    ['git -C /some/path log', 'git log', ''],
    ['bash scripts/deploy.sh', 'bash deploy.sh', ''],
    ['python3 << "EOF"\nprint("hi")\nEOF', 'python3', ''],
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
    ['f=a.md && cat $f', 'cat', ''],
    ['f=a.md ; wc -l $f', 'wc', ''],
    ['f=a.md && g=b.md && echo hdr && wc -l $f', 'wc', ''],
    ['echo hdr && f=a.md && grep x $f', 'grep', 'x'],
    ['f=a.md &&', '(bash)', ''],
    ['f=a.md', '(script)', ''],
    ['f=x ; TOK="Bearer ghp_zzz" ; curl -H "$TOK" https://api.io', 'curl', 'api.io'],
    ['f="a b.md"; wc -l "$f"', 'wc', ''],
    ['git status --short && git branch --show-current', 'git status', ''],
    ['cat >> out.md', 'cat', ''],
  ];
  for (const [command, groupKey, detail] of CASES) {
    test(`names ${JSON.stringify(command.slice(0, 44))} as ${groupKey}`, () => {
      const feature = bashFeature(command);
      assert.equal(feature.name, groupKey, command);
      assert.equal(feature.detail, detail, command);
    });
  }

  test('a residual name and detail are each capped', () => {
    const long = 'a'.repeat(80);
    const feature = bashFeature(`${long} ${long}`);
    assert.equal(feature.name.length, 40);
    assert.equal(feature.detail.length, 40);
  });

  test('a secret in the raw command never reaches the residual', () => {
    const serialized = JSON.stringify(bashFeature('echo API_TOKEN=s3cr3tvalue'));
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
