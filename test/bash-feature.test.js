import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { bashFeature } from '../lib/bash-feature.js';

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
