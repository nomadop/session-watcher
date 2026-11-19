// test/helpers/dsh-shipped-entry.js — the isolated runtime-resolution rig of the shipped host entry: one scenario of a child script in a fresh Node process whose home, Harness home and temp directory sit in a fixture, over a temporary profile that links this repository's DSH package.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const APP_BOOT = 'packages/boot/app-boot/lib/index.js';

/** Why the shipped-entry cases skip under the checkout `checkout` names, or false. */
export const shippedEntrySkip = checkout => (!checkout ? 'SW_DSH_CHECKOUT is unset'
  : existsSync(join(checkout, APP_BOOT)) ? false : `SW_DSH_CHECKOUT names no ${APP_BOOT}`);

// A fixture directory holding the home, the Harness home and the temp directory a child process starts with, and a temporary profile whose `node_modules` links the DSH package of this repository and whose `load.js` imports it by name from inside the profile.
function shippedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sw-dsh-shipped-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const profile = join(root, 'profile');
  for (const path of ['home', 'dsh-home', 'tmp', join('profile', 'node_modules', '@nomadop')]) mkdirSync(join(root, path), { recursive: true });
  symlinkSync(join(REPO, 'dsh'), join(profile, 'node_modules', '@nomadop', 'session-watcher-dsh'), 'dir');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'sw-shipped-fixture-profile', private: true, type: 'module',
    dependencies: { '@nomadop/session-watcher-dsh': '*' },
    dsh: { profile: { bundles: ['@nomadop/session-watcher-dsh'] } },
  }));
  writeFileSync(join(profile, 'load.js'), [
    "export const loadEntry = () => import('@nomadop/session-watcher-dsh');",
    "export const loadPiAiEntry = () => import('@nomadop/session-watcher-dsh/pi-ai');",
    '',
  ].join('\n'));
  return { root, profile };
}

// The scenario of a child script, `dsh-shipped-entry-child.js` unless `child` names another under this directory, in a fresh Node process whose `HOME`, `DSH_HOME` and `TMPDIR` are inside the fixture before anything is imported, beside the fixture-only variables `env` adds; a scenario that fails an assertion fails the case with the child's stderr, and what the child writes to stdout is the case's diagnostic.
export function runShippedScenario(t, scenario, checkout, { child = 'dsh-shipped-entry-child.js', timeout = 60_000, env = {} } = {}) {
  assert.ok(existsSync(join(REPO, 'dsh', 'dist', 'index.js')), 'dsh/dist/index.js is not built; run node scripts/build.js');
  const { root, profile } = shippedFixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./${child}`, import.meta.url)), scenario], {
    encoding: 'utf8',
    timeout,
    env: {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      DSH_HOME: join(root, 'dsh-home'),
      TMPDIR: join(root, 'tmp'),
      SW_DSH_CHECKOUT: checkout,
      SW_FIXTURE_PROFILE: profile,
      SW_FIXTURE_IMPORTER: join(profile, 'load.js'),
      ...env,
    },
  });
  assert.equal(result.status, 0, `scenario ${scenario} exited ${result.status} (${result.signal})\n${result.stderr}`);
  if (result.stdout.length > 0) t.diagnostic(result.stdout.trimEnd());
  return result;
}

