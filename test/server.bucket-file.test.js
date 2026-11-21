// `POST /api/bucket/file`: the lines the watcher holds of one path, read from the working tree at the moment of the request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { ATTRIBUTION_LIMITS } from '../lib/constants.js';
import { bootTestServer } from './helpers/server-boot.js';

const CONTENT = 'alpha\nbeta\ngamma\n';

let ctx;
let held;
before(async () => {
  ctx = await bootTestServer({ sessionId: 'sess-bucket-file' });
  [held] = ctx.touchBucketPaths(['src/held.js'], { content: CONTENT });
});
after(async () => { await ctx.teardown(); });

const post = body => ctx.requestRaw('/api/bucket/file', { method: 'POST', body });

test('a held path answers its total and the lines it holds, numbered, as the file reads now', async () => {
  const response = await post({ path: held });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.path, held);
  assert.equal(payload.total, 3);
  assert.deepEqual(payload.runs, [{
    offset: 1, lines: [{ number: 1, text: 'alpha' }, { number: 2, text: 'beta' }, { number: 3, text: 'gamma' }],
  }]);
});

test('a path the watcher does not hold, a Skill key included, is 404 not_held', async () => {
  for (const path of [`${held}.other`, 'skill:tdd']) {
    const response = await post({ path });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_held', message: 'The path is not held in the current context.' }, path);
  }
});

test('a body without a string path is 400 invalid_body', async () => {
  for (const body of [{}, { path: 7 }, { path: null }, []]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: 'invalid_body', message: 'Body must contain { path: string }' }, JSON.stringify(body));
  }
});

test('a held file the disk lost answers its reason', async () => {
  const [lost] = ctx.touchBucketPaths(['src/lost.js'], { content: CONTENT });
  rmSync(lost);
  const response = await post({ path: lost });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: lost, reason: 'missing' });
});

test('a held file over the size limit answers too-large', async () => {
  const [big] = ctx.touchBucketPaths(['src/big.js'], { content: CONTENT });
  writeFileSync(big, 'x'.repeat(ATTRIBUTION_LIMITS.fileBytes + 1));
  const response = await post({ path: big });
  assert.deepEqual(await response.json(), { path: big, reason: 'too-large' });
});
