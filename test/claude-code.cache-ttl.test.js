// test/claude-code.cache-ttl.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClaudeCodeCacheTtl } from '../lib/harness/claude-code/cache-ttl.js';

// The cache TTL is a host request attribute, not a model attribute: the harness decides how long a cache
// entry it writes should live, and the provider prices that choice. This module reports only what the host
// declared, verbatim, and names no price — which TTL token maps to which C ratio belongs to the model
// policy table, so an unrecognised declaration is passed along for that table's own fallback to absorb
// rather than being second-guessed here.

test('resolveClaudeCodeCacheTtl: a declared TTL is reported verbatim', () => {
  for (const declared of ['1h', '5m']) {
    assert.equal(resolveClaudeCodeCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: declared }), declared);
  }
});

test('resolveClaudeCodeCacheTtl: an undeclared TTL resolves absent', () => {
  assert.equal(resolveClaudeCodeCacheTtl({}), null);
});

test('resolveClaudeCodeCacheTtl: surrounding whitespace does not reach the policy table', () => {
  assert.equal(resolveClaudeCodeCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '  1h  ' }), '1h');
});

// The sub-agent declaration governs requests this process never issues: a sub-agent runs as its own session
// against its own transcript, so every call in the transcript a watcher reads was issued by the process whose
// environment this module reports. Reading the sub-agent variable here would price a watched context on a
// lifetime no call in it was served under.
test('resolveClaudeCodeCacheTtl: the sub-agent declaration alone does not move the resolved TTL', () => {
  assert.equal(resolveClaudeCodeCacheTtl({ CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' }), null);
});

test('resolveClaudeCodeCacheTtl: the main declaration wins over a differing sub-agent one', () => {
  assert.equal(resolveClaudeCodeCacheTtl({
    CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m',
  }), '1h');
});

test('resolveClaudeCodeCacheTtl: the host environment is the default source', () => {
  const saved = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  try {
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h';
    assert.equal(resolveClaudeCodeCacheTtl(), '1h');
    delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
    assert.equal(resolveClaudeCodeCacheTtl(), null);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
    else process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = saved;
  }
});
