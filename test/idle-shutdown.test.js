import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIdleShutdown, IDLE_SHUTDOWN_MS } from '../server.js';

test('shouldIdleShutdown: fresh server does not trigger immediately', () => {
  const now = 1000;
  const lastRequestMono = now; // just received a request
  assert.equal(shouldIdleShutdown({ sseClientsSize: 0, lastRequestMono, now }), false);
});

test('shouldIdleShutdown: triggers after IDLE_SHUTDOWN_MS with no requests and no clients', () => {
  const lastRequestMono = 0;
  const now = IDLE_SHUTDOWN_MS + 1; // just past the threshold
  assert.equal(shouldIdleShutdown({ sseClientsSize: 0, lastRequestMono, now }), true);
});

test('shouldIdleShutdown: SSE client connected prevents trigger even after timeout', () => {
  const lastRequestMono = 0;
  const now = IDLE_SHUTDOWN_MS + 100000; // way past the threshold
  assert.equal(shouldIdleShutdown({ sseClientsSize: 1, lastRequestMono, now }), false);
});

test('shouldIdleShutdown: a request resets the idle clock', () => {
  const now = IDLE_SHUTDOWN_MS + 1;
  const lastRequestMono = now - 5000; // request 5s ago
  assert.equal(shouldIdleShutdown({ sseClientsSize: 0, lastRequestMono, now }), false);
});

test('shouldIdleShutdown: exactly at threshold does not trigger (boundary)', () => {
  const lastRequestMono = 0;
  const now = IDLE_SHUTDOWN_MS; // exactly at threshold, not past
  assert.equal(shouldIdleShutdown({ sseClientsSize: 0, lastRequestMono, now }), false);
});
