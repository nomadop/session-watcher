// The DSH host's skill registrations from the shipped `SKILL.md` files, and the absence of any message injected into an agent that starts or resumes, over a fake context and a store under a temporary directory.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { registerSkills } from '../dsh/src/skills.js';
import { createTools } from '../dsh/src/tools.js';
import { getStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { discoverHandoffs, formatHandoffContext } from '../lib/handoff-discovery.js';
import {
  HANDOFF_HOOK_TTL_DAYS, HANDOFF_HOOK_QUERY_LIMIT, HANDOFF_HOOK_MAX_DISPLAY, HANDOFF_HOOK_TASK_PREVIEW_CHARS,
} from '../lib/constants.js';
import { createFakeContext, fakeSession, fakeAgent } from './helpers/dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const CWD = '/repo';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-skills-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const storePath = () => join(dir, 'store.sqlite');

// The host over a fake context with no connection; the tools `ctx.tools.register` receives are recorded in order.
function mountHost() {
  const ctx = createFakeContext({ readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }) });
  const registeredTools = [];
  const register = ctx.tools.register;
  ctx.tools.register = (definition) => { registeredTools.push(definition); register(definition); };
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: storePath(), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR,
  });
  return { ctx, table, registeredTools };
}

// One pending handoff prepared by `sourceSessionId` under the project `cwd` resolves to.
function seedPendingHandoff({ sourceSessionId = 's-source', cwd = CWD } = {}) {
  getStore().insertHandoff({
    sessionId: sourceSessionId, segment: 0, loadToken: 'tok-pending', createdAt: Date.now(), pathsToKeep: '[]',
    summary: 'the prepared summary', nextTask: 'Continue the parser refactor.', summaryTokens: 10,
    projectId: resolve(cwd), transcriptPath: sourceSessionId,
  });
}

// The text the Claude Code SessionStart hook builds for `sessionId` under `cwd`.
function hookText(sessionId, cwd = CWD) {
  const rows = discoverHandoffs(storePath(), resolve(cwd), sessionId, {
    ttlDays: HANDOFF_HOOK_TTL_DAYS, queryLimit: HANDOFF_HOOK_QUERY_LIMIT,
  });
  return formatHandoffContext(rows, HANDOFF_HOOK_MAX_DISPLAY, HANDOFF_HOOK_TASK_PREVIEW_CHARS);
}

// A newly created agent announced with `source`.
function announce(ctx, source, session = fakeSession({ id: 's-agent', cwd: CWD })) {
  const agent = fakeAgent(session);
  ctx.emit('agent/created', { agent, source });
  return agent;
}

// Each `<SKILLS_DIR>/<name>/SKILL.md` with the frontmatter values YAML reads off it and the first non-blank line after its closing fence.
function shippedSkills() {
  return readdirSync(SKILLS_DIR)
    .map(name => join(SKILLS_DIR, name))
    .filter(directory => existsSync(join(directory, 'SKILL.md')))
    .map((directory) => {
      const path = join(directory, 'SKILL.md');
      const lines = readFileSync(path, 'utf8').split('\n');
      const value = key => {
        const raw = lines.find(line => line.startsWith(`${key}: `)).slice(key.length + 2);
        return raw.startsWith('"') ? JSON.parse(raw) : raw;
      };
      const closingFence = lines.indexOf('---', 1);
      const firstBodyLine = lines.slice(closingFence + 1).find(line => line.trim() !== '');
      return { name: value('name'), description: value('description'), directory, path, firstBodyLine };
    });
}

const byName = (a, b) => a.name.localeCompare(b.name);

test('every SKILL.md under the directory registers once with its frontmatter name and description and its directory as resource base', () => {
  const ctx = createFakeContext();
  registerSkills(ctx, { skillsDir: SKILLS_DIR });

  const skills = shippedSkills().sort(byName);
  assert.equal(skills.length, 3);
  const registered = [...ctx.skills.registered].sort(byName);
  assert.deepEqual(registered.map(({ content, ...registration }) => registration), skills.map(skill => ({
    name: skill.name, description: skill.description, source: 'bundled',
    resourceBase: { kind: 'directory', path: skill.directory }, path: skill.path,
  })));
  registered.forEach(({ name, content }, index) => {
    assert.ok(content.startsWith(skills[index].firstBodyLine), `${name} content opens with the body`);
    assert.doesNotMatch(content, /^---$/m, `${name} content carries no frontmatter fence`);
  });
});

test('an agent announced at startup and at resume is injected no message although the hook announces its project\'s pending handoff', () => {
  const { ctx } = mountHost();
  seedPendingHandoff();

  assert.match(hookText('s-agent'), /tok-pending/, 'the hook announces the seeded handoff');
  for (const source of ['startup', 'resume']) assert.deepEqual(announce(ctx, source).injected, [], source);
});

test('without a connection the tools and the skills are still registered', () => {
  const { ctx, table, registeredTools } = mountHost();

  const toolNames = createTools({ defineTool: definition => definition, table, store: getStore() })
    .map(definition => definition.name);
  assert.deepEqual(registeredTools.map(definition => definition.name), toolNames);
  assert.deepEqual(ctx.skills.registered.map(skill => skill.name).sort(), shippedSkills().map(skill => skill.name).sort());
});
