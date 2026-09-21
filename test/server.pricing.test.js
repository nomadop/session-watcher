// test/server.pricing.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal, openStore, closeStore } from '../lib/store.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../lib/constants.js';
import { createWatcherComposition } from '../server.js';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';
import { writeMeasuredTranscript } from './helpers/server-boot.js';

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sw-psrv-'));
  initStore(join(tmpDir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(tmpDir, { recursive: true, force: true });
});

// The displayed model is the LATEST MEASURED STEP's, so the fixture carries a step with that model rather
// than a field being stamped: `getCurrentModel()` is the only model read, and it answers from measurement.
async function withServer(opts, fn) {
  const { composeForTranscript } = await import('./helpers/server-boot.js');
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({
      steps: 2, model: opts.model || 'test-model', laterModel: opts.laterModel,
    }),
    sessionId: opts.sid || 'test',
    ratioOverride: opts.ratioOverride ?? null,
    cacheTtl: opts.cacheTtl,
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, composed.watcher); }
  finally { stopTimers(); await composed.teardown(); }
}

test('GET /api/pricing — no saved, no CLI → model_default', async () => {
  await withServer({ sid: 'g1' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`);
    const body = await res.json();
    assert.equal(body.effective.source, 'model_default');
    assert.equal(body.saved, null);
  });
});

// One composition holds one declared prompt-cache TTL, and it prices the cache write for BOTH the ratio
// measurement charges and the model default this route reports: a dashboard quoting one cache lifetime's
// price beside a session measured on another would report a price nothing charged. No lifetime's magnitude
// is written here — the expectation is the policy lookup's own answer at the declared TTL, so the numbers
// stay the table's to state.
test('GET /api/pricing — the declared prompt-cache TTL prices measurement and the reported model default', async () => {
  const model = 'claude-opus-4-8';
  await withServer({ sid: 'ttl1', model, cacheTtl: '1h' }, async (port, watcher) => {
    const atDeclared = modelPolicyFor(model, '1h').cRatio;
    assert.notEqual(atDeclared, modelPolicyFor(model, DEFAULT_CACHE_TTL).cRatio,
      'this model must be priced apart on the two lifetimes, or the case discriminates nothing');
    assert.equal(watcher.getStatus().cRatio, atDeclared, 'measurement resolved the declared lifetime');
    const body = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    assert.equal(body.effective.source, 'model_default');
    assert.equal(body.effective.ratio, atDeclared, 'the reported default is the price measurement charged');
  });
});

// Where the lifetime comes from when nobody injects one: the composition root reads the host's declaration
// and binds it, so the measured ratio follows the environment the harness actually runs under. Every case
// above hands the composition a lifetime, so this is the only one that fails if that binding is deleted —
// and without it a declared lifetime is decoration and every priced reading quietly charges the default.
test('createWatcherComposition — an uninjected cache lifetime is the host declaration', () => {
  const model = 'claude-opus-4-8';
  const declared = '1h';
  const atDeclared = modelPolicyFor(model, declared).cRatio;
  assert.notEqual(atDeclared, modelPolicyFor(model, DEFAULT_CACHE_TTL).cRatio,
    'this model must be priced apart on the two lifetimes, or the case discriminates nothing');

  const transcriptPath = writeMeasuredTranscript({ steps: 2, model });
  const store = openStore(join(tmpDir, 'env-ttl.sqlite'));
  const savedDeclaration = process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  try {
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = declared;
    const watcher = createWatcherComposition({
      sessionId: 'env-ttl', sourceLocator: transcriptPath, projectId: null, projectRoot: tmpDir,
      stateDir: join(tmpDir, 'state'), store, isIgnored: null,
    });
    watcher.applyHarnessFrame(createClaudeCodeSourceDriver({ sourceLocator: transcriptPath }).advance());
    assert.equal(watcher.getStatus().cRatio, atDeclared,
      'the composition resolved the ratio at the lifetime the host declared');
  } finally {
    closeStore(store);
    if (savedDeclaration === undefined) delete process.env.CLAUDE_CODE_PROMPT_CACHE_TTL;
    else process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = savedDeclaration;
  }
});

test('POST /api/pricing — valid → saves, effective=saved', async () => {
  await withServer({ sid: 'p1' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.30, writePrice: 3.00 })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.effective.source, 'saved');
    assert.equal(body.effective.ratio, 10);
    assert.equal(body.saved.readPrice, 0.30);
  });
});

test('POST /api/pricing — invalid → 400, no mutation', async () => {
  await withServer({ sid: 'p2' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 3, writePrice: 0.3 })
    });
    assert.equal(res.status, 400);
    const get = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    assert.equal(get.saved, null);
  });
});

test('POST /api/pricing — overrides CLI ratio', async () => {
  await withServer({ sid: 'p3', ratioOverride: 15 }, async (port) => {
    const before = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    assert.equal(before.effective.source, 'cli');
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.30, writePrice: 3.00 })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.effective.source, 'saved');
    assert.equal(body.effective.ratio, 10);
  });
});

test('DELETE /api/pricing — clears saved, reverts to CLI or model_default', async () => {
  await withServer({ sid: 'p4' }, async (port) => {
    await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.30, writePrice: 3.00 })
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, null);
    assert.equal(body.effective.source, 'model_default');
  });
});

test('GET /api/pricing — includes presets array from constants', async () => {
  await withServer({ sid: 'preset1' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`);
    const body = await res.json();
    assert.ok(Array.isArray(body.presets));
    // Each preset has id, label, readPrice, writePrice
    for (const p of body.presets) {
      assert.ok(typeof p.id === 'string');
      assert.ok(typeof p.label === 'string');
      assert.ok(typeof p.readPrice === 'number');
      assert.ok(typeof p.writePrice === 'number');
    }
  });
});

test('POST /api/pricing — with presetId matching preset prices → source=preset', async () => {
  await withServer({ sid: 'preset2' }, async (port) => {
    // Prices must match the preset definition in constants.js (opus-4.8: read=0.50, write=6.25)
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.50, writePrice: 6.25, presetId: 'opus-4.8' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved.presetId, 'opus-4.8');
    assert.equal(body.effective.source, 'preset');  // prices match → source is preset
  });
});

test('GET /api/pricing — preset drift: saved presetId with changed prices → source=saved', async () => {
  await withServer({ sid: 'preset3' }, async (port) => {
    // Save with a presetId but prices that don't match current preset data
    await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 999, writePrice: 999, presetId: 'opus-4' })
    });
    const get = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    // Drift detected: source should be 'saved' not 'preset'
    assert.equal(get.effective.source, 'saved');
  });
});

test('POST /api/pricing — no model detected → 409', async () => {
  const { composeForTranscript } = await import('./helpers/server-boot.js');
  const { mkdtempSync: mkd, writeFileSync: wf } = await import('node:fs');
  // An EMPTY Source: readable, so the owner installs a driver, but with no measured step there is no model
  // for `getCurrentModel()` to report — which is exactly what the guard answers 409 to.
  const empty = join(mkd(join(tmpdir(), 'sw-nomodel-')), 'empty.jsonl');
  wf(empty, '');
  const composed = composeForTranscript({ transcriptPath: empty, sessionId: 'no-model-test' });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 3, writePrice: 15 })
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'no_model');
  } finally {
    stopTimers();
    await composed.teardown();
  }
});

// ── The model identity pricing keys on ────────────────────────────────────────
// Pricing is a model-DEPENDENT read, so it resolves from the EPOCH model — the first measured step's model in
// the epoch — not from the latest measured step's identity, which is what a status display shows. The two
// genuinely differ inside one epoch, and the same value is the KEY the per-model override is stored under, so
// taking the latest identity would move an override's key mid-epoch and read back a different model's prices.
test('GET /api/pricing — modelDefault.model is the EPOCH model, not the latest measured one', async () => {
  await withServer({ sid: 'epoch-model', model: 'claude-opus-4-8', laterModel: 'claude-sonnet-4-5' },
    async (port, watcher) => {
      // Precondition: the fixture really does carry two identities, or this asserts nothing.
      assert.equal(watcher.getEpochModel(), 'claude-opus-4-8', 'the epoch opened on opus');
      assert.equal(watcher.getCurrentModel(), 'claude-sonnet-4-5', 'and the latest measured step is sonnet');

      const body = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
      assert.equal(body.modelDefault.model, 'claude-opus-4-8',
        'the pricing wire names the epoch model');
      // And the status display keeps the latest identity: the two reads are deliberately different sources.
      const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
      assert.equal(status.model, 'claude-sonnet-4-5');
    });
});

test('POST then GET /api/pricing — the saved override is stored under the EPOCH model and read back by it', async () => {
  await withServer({ sid: 'epoch-key', model: 'claude-opus-4-8', laterModel: 'claude-sonnet-4-5' },
    async (port) => {
      const posted = await (await fetch(`http://127.0.0.1:${port}/api/pricing`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readPrice: 3, writePrice: 15 }),
      })).json();
      assert.equal(posted.effective.source, 'saved', 'the POST took effect');

      // The storage key is where being wrong actually costs something: an override written under the latest
      // identity would not be found by the read, which resolves the epoch model.
      const { loadPricingOverride } = await import('../lib/pricing-store.js');
      assert.ok(loadPricingOverride('claude-opus-4-8'), 'the override is stored under the epoch model');
      assert.equal(loadPricingOverride('claude-sonnet-4-5'), null,
        'and NOT under the latest measured identity');

      // Read back through the route: it finds its own key.
      const got = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
      assert.equal(got.effective.source, 'saved');
      assert.equal(got.effective.readPrice, 3);
      assert.equal(got.modelDefault.model, 'claude-opus-4-8');
    });
});
