// The DSH host's skill registrations from the shipped `SKILL.md` files and its handoff catalog injection at agent creation, over a fake context and a store under a temporary directory.
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
import { reduceDshEvent } from '../lib/harness/dsh/transcript-observation.js';
import {
  HANDOFF_HOOK_TTL_DAYS, HANDOFF_HOOK_QUERY_LIMIT, HANDOFF_HOOK_MAX_DISPLAY, HANDOFF_HOOK_TASK_PREVIEW_CHARS,
} from '../lib/constants.js';
import { userMessage } from './helpers/dsh-events.js';
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

const settled = () => new Promise(resolve => setImmediate(resolve));

// Stderr captured for the case, restored after it.
function captureStderr(t) {
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = realError; });
  return lines;
}

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

test('a startup agent with a pending handoff from another session is injected one catalog message whose text is the hook\'s', () => {
  const { ctx } = mountHost();
  seedPendingHandoff();

  const agent = announce(ctx, 'startup');

  const text = hookText('s-agent');
  assert.match(text, /tok-pending/, 'the hook announces the seeded handoff');
  assert.equal(agent.injected.length, 1);
  const { id, ...message } = agent.injected[0];
  assert.match(id, /./, 'an identified message');
  assert.deepEqual(message, {
    role: 'user', content: [{ type: 'text', text }], source: { kind: 'session-watcher', form: 'catalog' },
  });
});

test('resume injects, clear and compact do not', () => {
  const { ctx } = mountHost();
  seedPendingHandoff();

  assert.equal(announce(ctx, 'resume').injected.length, 1, 'resume');
  for (const source of ['clear', 'compact']) assert.deepEqual(announce(ctx, source).injected, [], source);
});

test('no pending handoff and no cwd inject nothing', () => {
  const { ctx } = mountHost();
  assert.deepEqual(announce(ctx, 'startup').injected, [], 'no pending handoff');

  seedPendingHandoff();
  const headerless = { ...fakeSession({ id: 's-headerless' }), header: {} };
  assert.deepEqual(announce(ctx, 'startup', headerless).injected, [], 'no cwd');
});

test('a subagent child inheriting the parent\'s cwd is injected nothing', () => {
  const { ctx } = mountHost();
  seedPendingHandoff();

  const child = fakeSession({ id: 's-child', cwd: CWD, origin: 'subagent', parentSession: 's-agent' });
  assert.deepEqual(announce(ctx, 'startup', child).injected, []);
});

test('a user fork carrying its parent session and no origin is injected one catalog message', () => {
  const { ctx } = mountHost();
  seedPendingHandoff();

  const fork = fakeSession({ id: 's-fork', cwd: CWD, parentSession: 's-agent' });
  assert.equal(announce(ctx, 'startup', fork).injected.length, 1);
});

test('an agent whose inject throws writes a handler_failed line and its session\'s watcher stays live', async (t) => {
  const lines = captureStderr(t);
  const { ctx, table } = mountHost();
  seedPendingHandoff();
  const session = fakeSession({ id: 's-agent', cwd: CWD });
  ctx.emit('session/created', session);
  await settled();

  const agent = { session, inject() { throw new Error('inject refused'); } };
  assert.doesNotThrow(() => ctx.emit('agent/created', { agent, source: 'startup' }));
  assert.deepEqual(lines.filter(line => line.includes('[dsh-host]')), ['s-agent [dsh-host] handler_failed: inject refused']);
  assert.equal(table.get('s-agent').state, 'live');
  ctx.dispose();
});

test('without a connection the tools and the skills are still registered', () => {
  const { ctx, table, registeredTools } = mountHost();

  const toolNames = createTools({ defineTool: definition => definition, table, store: getStore() })
    .map(definition => definition.name);
  assert.deepEqual(registeredTools.map(definition => definition.name), toolNames);
  assert.deepEqual(ctx.skills.registered.map(skill => skill.name).sort(), shippedSkills().map(skill => skill.name).sort());
});

test('the injected source kind yields no Observation', () => {
  const { ctx } = mountHost();
  seedPendingHandoff();
  const [message] = announce(ctx, 'startup').injected;

  assert.deepEqual(reduceDshEvent({ ...userMessage({ text: 'unused' }), data: message }), { observations: [], diagnostics: [] });
});
