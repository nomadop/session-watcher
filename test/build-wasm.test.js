import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const EXPECTED = [
  'web-tree-sitter.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-python.wasm',
];

test('build copies all WASM files to dist/', () => {
  // Only rebuild if a WASM artifact is missing. scripts/build.js opens with
  // rmSync(dist, {recursive:true}), so an unconditional build deletes dist/ out from
  // under cli-e2e.test.js and build-cli.test.js, which spawn dist/bin/session-watcher.js
  // in parallel. Same guard as build-cli.test.js for the same reason.
  if (EXPECTED.some((file) => !existsSync(join(DIST, file)))) {
    execSync('node scripts/build.js', { cwd: ROOT, stdio: 'pipe' });
  }
  for (const file of EXPECTED) {
    assert.ok(existsSync(join(DIST, file)), `${file} missing from dist/`);
  }
});
