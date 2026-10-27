// test/helpers/working-tree-fixtures.js — the local synthesized working trees: `fixtures/working-trees/<name>.json`, a
// tree as `scripts/synthesize-working-tree.mjs` writes it from a local transcript, one per transcript fixture and
// named for it. They hold text taken from real sessions and are never committed, so a fixture case that attributes
// by one runs only where both its transcript and its tree are present.
import { existsSync, readFileSync } from 'node:fs';
import { createMemoryWorkingTree } from '../../lib/working-tree.js';
import { pathFlavorOf } from '../../scripts/synthesize-working-tree.mjs';

const TREE_DIR = new URL('../../fixtures/working-trees/', import.meta.url);

const treeUrl = name => new URL(`${name}.json`, TREE_DIR);

/** Whether the named tree is present; a fixture case that attributes by it skips on `!hasWorkingTreeFixture(name)`. */
export function hasWorkingTreeFixture(name) {
  return existsSync(treeUrl(name));
}

/**
 * The named tree, held in memory in the path namespace its files are in.
 * @param {string} name
 * @param {?string} [homeDir] the home directory a `~` stands for; none by default, as in DSH
 */
export function readWorkingTreeFixture(name, homeDir = null) {
  const files = JSON.parse(readFileSync(treeUrl(name), 'utf8'));
  return createMemoryWorkingTree({ files, path: pathFlavorOf(Object.keys(files)[0]), homeDir });
}
