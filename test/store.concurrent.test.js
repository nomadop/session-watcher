import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore, closeStore } from '../lib/store.js';

const execFileAsync = promisify(execFile);

test('two Store instances on same DB can alternate writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-conc-'));
  const dbPath = join(dir, 'shared.sqlite');
  const s1 = openStore(dbPath);
  const s2 = openStore(dbPath);

  s1.save('sid1', 'ledger', { from: 's1' });
  s2.save('sid1', 'gate', { from: 's2' });

  assert.deepEqual(s1.load('sid1', 'gate'), { from: 's2' });
  assert.deepEqual(s2.load('sid1', 'ledger'), { from: 's1' });

  closeStore(s1);
  closeStore(s2);
  rmSync(dir, { recursive: true, force: true });
});

test('multi-process concurrent saveBatch (child_process)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-mp-'));
  const dbPath = join(dir, 'shared.sqlite');

  // Pre-create the DB so schema is ready for workers
  const s = openStore(dbPath);
  closeStore(s);

  const worker = `
    import { openStore, closeStore } from ${JSON.stringify(join(process.cwd(), 'lib/store.js'))};
    const store = openStore(${JSON.stringify(dbPath)});
    const id = process.argv[2];
    for (let i = 0; i < 50; i++) {
      store.saveBatch('sid-' + id, [['k' + i, { v: i }]]);
    }
    closeStore(store);
  `;

  const workerFile = join(dir, 'worker.mjs');
  writeFileSync(workerFile, worker);

  // Run 3 workers truly in parallel (spawn, not execSync)
  await Promise.all([1, 2, 3].map(id =>
    execFileAsync(process.execPath, [workerFile, String(id)], { timeout: 15000 })
  ));

  // Verify all writes landed
  const store = openStore(dbPath);
  for (const id of [1, 2, 3]) {
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(store.load(`sid-${id}`, `k${i}`), { v: i });
    }
  }
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});
