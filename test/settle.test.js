import test from 'node:test';
import assert from 'node:assert/strict';
import { settleDeferred } from '../lib/settle.js';

test('settleDeferred: catch-up emits NO phantom residual (report #1)', () => {
  const g = { total: 0, byPath: new Map() };
  const r1 = settleDeferred(30, 100, new Map([['/big', 100]]), g); // credit ahead of L
  assert.equal(r1.residual, 0);
  assert.equal(Math.round(g.total), 70);
  const r2 = settleDeferred(70, 0, new Map(), g);                   // L catches up the banked batch
  assert.equal(r2.residual, 0, 'catch-up ΔL must retire, never become residual');
  assert.equal(g.total, 0);
});

test('settleDeferred: Dₐ=max(0,D+ΔB−ΔL) & residual=max(0,ΔL−ΔB−D) hold every row', () => {
  const rows = [
    { dB: 200, dL: 0,   paths: new Map([['/a', 120], ['/b', 80]]) },
    { dB: 0,   dL: 50,  paths: new Map() },
    { dB: 40,  dL: 90,  paths: new Map([['/a', 40]]) },
    { dB: 0,   dL: 500, paths: new Map() }, // over-retire: exhausts ledger, rest is residual
    { dB: 10,  dL: 10,  paths: new Map([['/c', 10]]) },
  ];
  const g = { total: 0, byPath: new Map() };
  let D = 0;
  for (const row of rows) {
    const expD = Math.max(0, D + row.dB - row.dL);
    const expResid = Math.max(0, row.dL - row.dB - D);
    const r = settleDeferred(row.dL, row.dB, row.paths, g);
    let sum = 0; for (const v of g.byPath.values()) sum += v;
    assert.ok(Math.abs(g.total - expD) < 1e-6, `deferred: got ${g.total}, want ${expD}`);
    assert.ok(Math.abs(r.residual - expResid) < 1e-6, `residual: got ${r.residual}, want ${expResid}`);
    assert.ok(Math.abs(sum - g.total) < 1e-6, `Σ byPath (${sum}) must equal total (${g.total})`);
    D = expD;
  }
});

test('settleDeferred: scalar/Map never desync across many fractional retirements', () => {
  const g = { total: 0, byPath: new Map() };
  settleDeferred(0, 999, new Map([['/x', 333], ['/y', 333], ['/z', 333]]), g);
  for (let i = 0; i < 50; i++) settleDeferred(7, 0, new Map(), g);
  let sum = 0; for (const v of g.byPath.values()) sum += v;
  assert.ok(Math.abs(sum - g.total) < 1e-6);
  settleDeferred(99999, 0, new Map(), g); // drain
  assert.ok(g.total < 1e-6 && g.byPath.size === 0, 'full drain zeroes both scalar and Map');
});
