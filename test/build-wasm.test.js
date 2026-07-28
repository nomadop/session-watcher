import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');

test('build copies all WASM files to dist/', () => {
  execSync('npm run build', { cwd: join(__dirname, '..'), stdio: 'pipe' });
  const expected = [
    'web-tree-sitter.wasm',
    'tree-sitter-javascript.wasm',
    'tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm',
    'tree-sitter-python.wasm',
  ];
  for (const file of expected) {
    assert.ok(existsSync(join(DIST, file)), `${file} missing from dist/`);
  }
});
