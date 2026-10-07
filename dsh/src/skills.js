// dsh/src/skills.js — the session watcher's skills, registered from the `SKILL.md` files under the directory the host is handed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `key: value` lines of the `---` fenced block that opens `text`, each value trimmed and stripped of one pair of enclosing quotes, and the text after the block's closing fence.
 * @returns {{ fields: Record<string, string>, body: string }} no fields and the whole text when `text` opens no fenced block
 */
function parseFrontmatter(text) {
  const [, block = '', body = text] = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)/.exec(text) ?? [];
  const fields = {};
  for (const [, key, value] of block.matchAll(/^([\w-]+):[ \t]*(.*?)[ \t]*$/gm)) {
    fields[key] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return { fields, body };
}

/** Register the `SKILL.md` of each directory under `skillsDir` on `ctx.skills` as a bundled skill whose content is the trimmed body after the frontmatter and whose resource base is its directory. */
export function registerSkills(ctx, { skillsDir }) {
  for (const entry of readdirSync(skillsDir)) {
    const directory = join(skillsDir, entry);
    const path = join(directory, 'SKILL.md');
    if (!existsSync(path)) continue;
    const { fields: { name, description }, body } = parseFrontmatter(readFileSync(path, 'utf8'));
    ctx.skills.register({
      name, description, content: body.trim(), source: 'bundled', resourceBase: { kind: 'directory', path: directory },
      path,
    });
  }
}
