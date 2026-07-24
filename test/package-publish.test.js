import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('package.json publish config', () => {
  it('has scoped name', () => {
    assert.equal(pkg.name, '@nomadop/session-watcher');
  });

  it('has bin entry pointing to dist', () => {
    assert.equal(pkg.bin['session-watcher'], './dist/bin/session-watcher.js');
  });

  it('has files whitelist', () => {
    assert.ok(Array.isArray(pkg.files));
    assert.ok(pkg.files.includes('dist/bin/'), 'should include dist/bin/');
    assert.ok(pkg.files.includes('dist/public/'), 'should include dist/public/');
  });

  it('has engines >=22.16.0', () => {
    assert.equal(pkg.engines.node, '>=22.16.0');
  });

  it('has public publishConfig', () => {
    assert.equal(pkg.publishConfig.access, 'public');
  });

  it('files whitelist does NOT include fixtures/, test/, or scripts/', () => {
    assert.ok(!pkg.files.includes('fixtures/'));
    assert.ok(!pkg.files.includes('test/'));
    assert.ok(!pkg.files.includes('scripts/'));
  });

  it('package.json itself is always included (npm default)', () => {
    // package.json is always shipped regardless of files whitelist — verify
    // nothing in files explicitly excludes it (can't actually exclude it).
    assert.ok(!pkg.files.includes('!package.json'));
  });
});
