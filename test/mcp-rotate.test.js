import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateSession } from '../lib/launcher.js';

test('rotateSession returns error when no server running', async () => {
  const env = { CLAUDE_CODE_SESSION_ID: `no-server-${Date.now()}` };
  const result = await rotateSession(env, { session_id: 'new-sess' });
  assert.equal(result.error, 'no_server');
});
