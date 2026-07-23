// test/cli-parse.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../lib/parse-args.js';

describe('parseCliArgs', () => {
  it('parses demo with defaults', () => {
    const r = parseCliArgs(['demo']);
    assert.equal(r.command, 'demo');
    assert.equal(r.speed, 20);
    assert.equal(r.port, 0);
    assert.equal(r.noOpen, false);
    assert.equal(r.transcriptPath, null);
  });

  it('parses replay with path and flags', () => {
    const r = parseCliArgs(['replay', '/tmp/session.jsonl', '--speed', '10', '--port', '8080', '--no-open']);
    assert.equal(r.command, 'replay');
    assert.equal(r.transcriptPath, '/tmp/session.jsonl');
    assert.equal(r.speed, 10);
    assert.equal(r.port, 8080);
    assert.equal(r.noOpen, true);
  });

  it('defaults to help with no args', () => {
    const r = parseCliArgs([]);
    assert.equal(r.command, 'help');
  });

  it('handles --help flag', () => {
    const r = parseCliArgs(['--help']);
    assert.equal(r.command, 'help');
  });

  it('handles --version flag', () => {
    const r = parseCliArgs(['--version']);
    assert.equal(r.command, 'version');
  });

  it('clamps speed to minimum 0.1', () => {
    const r = parseCliArgs(['demo', '--speed', '0']);
    assert.equal(r.speed, 0.1);
  });

  it('clamps port to valid range', () => {
    const r = parseCliArgs(['demo', '--port', '99999']);
    assert.equal(r.port, 0);
  });

  it('replay without path sets error', () => {
    const r = parseCliArgs(['replay']);
    assert.equal(r.command, 'replay');
    assert.equal(r.error, 'replay requires a transcript path');
  });
});
