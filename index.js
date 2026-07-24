#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { probeMcp } from './lib/probe.js';
import { PLUGIN_VERSION } from './lib/version.js';
// Re-export launcher functions for backward compatibility (tests, manual usage)
export { stateFileFor, resolveProjectDir, sessionIdOf, probeHealth, fetchHealth, readState, startWatcher, stopWatcher, watcherStatus, getBucketSummary, prepareHandoff, loadHandoff, rotateSession } from './lib/launcher.js';

// MCP wiring — only when run as the entrypoint (not when imported by tests).
// Use realpath to handle symlinks (e.g. devcontainer plugin cache symlink).
const __selfReal = realpathSync(fileURLToPath(import.meta.url));
const __argvReal = (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (__selfReal === __argvReal) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');

  // ── In-process watcher + Express server ──────────────────────────────────
  // MCP tools delegate to the in-process server via loopback fetch.
  {
    const { SessionWatcher } = await import('./lib/watcher.js');
    const { createServer, resolveBySessionId, PORT_DIR, safeSessionId } = await import('./server.js');
    const { archiveCurrentSegment } = await import('./lib/fold.js');
    const { initStore, closeStoreGlobal } = await import('./lib/store.js');

    const { resolveProjectKey } = await import('./lib/project-key.js');
    const { loadIsIgnored } = await import('./gitignore-loader.js');

    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'default';
    const projectsRoot = join(homedir(), '.claude', 'projects');
    const transcriptPath = resolveBySessionId(projectsRoot, sessionId);
    const cwd = process.cwd();
    const projectId = resolveProjectKey({ claudeProjectDir: process.env.CLAUDE_PROJECT_DIR, cwd });
    // NO /dev/null fallback — pass null if not found; watcher handles it gracefully (status='no_transcript')
    const watcher = new SessionWatcher(transcriptPath, null, {
      sessionId,
      projectId,
      cwd,
      isIgnored: loadIsIgnored(cwd),
    });

    const { server, startPolling, sseClients, stopTimers, startedAt, applyEffectiveRatio, currentSessionId, doRotation } =
      createServer({
        watcher,
        pollIntervalMs: 1000,
        sessionId,
        projectsRoot,
        stateDir: process.env.SW_STATE_DIR || null,
      });

    // effectiveStateDir mirrors createServer's own resolution (stateDir || PORT_DIR)
    const effectiveStateDir = process.env.SW_STATE_DIR || PORT_DIR;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stopTimers();
      // Destroy SSE connections to release event loop
      for (const c of sseClients) { try { c.end(); } catch {} }
      sseClients.clear();
      try { archiveCurrentSegment(watcher); } catch {}
      try { closeStoreGlobal(); } catch {}
      // Dynamic path — survives rotation
      const sid = currentSessionId();
      try { unlinkSync(join(effectiveStateDir, `${safeSessionId(sid)}.json`)); } catch {}
    };
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.unref();
      mkdirSync(effectiveStateDir, { recursive: true });
      try { initStore(); } catch (e) { console.error('[session-watcher] fatal: store init failed —', e.message); process.exit(1); }
      applyEffectiveRatio();
      // Plain overwrite — no EEXIST branch (in-process path owns its state file)
      writeFileSync(join(effectiveStateDir, `${safeSessionId(sessionId)}.json`), JSON.stringify({
        port,
        pid: process.pid,
        clientPid: process.ppid,
        transcriptPath,
        sessionId,
        startedAt,
      }));
      startPolling();
    });

    // Register MCP tools that delegate to the in-process server via loopback
    const mcpServer = new McpServer({ name: 'session-watcher', version: PLUGIN_VERSION });
    const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
    const probeCall = (tool, args) => probeMcp({
      tool, sessionIdArg: args?.sessionId,
      envSessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    const SessionIdSchema = { sessionId: z.string().optional().describe('Override session ID (used when resume changes the ID)') };

    const inprocFetch = async (path, opts = {}) => {
      // Wait briefly for the server to be ready (port assigned after listen callback)
      let retries = 0;
      while (!server.listening && retries < 30) {
        await new Promise(r => setTimeout(r, 100));
        retries++;
      }
      const port = server.address()?.port;
      if (!port) return { error: 'server_not_ready' };
      const url = `http://127.0.0.1:${port}${path}`;
      const res = await fetch(url, opts);
      return res.json();
    };

    mcpServer.registerTool('start_watcher', {
      description: 'Start (or reuse) the Session Watcher dashboard server; returns its URL. Never returns metric values.',
      inputSchema: { ...SessionIdSchema, transcript: z.string().optional().describe('Explicit transcript .jsonl path (overrides session ID lookup)') },
      annotations: { readOnlyHint: true },
    }, async ({ sessionId: _sid } = {}) => {
      probeCall('start_watcher', { sessionId: _sid });
      const port = server.address()?.port;
      if (!port) return reply({ error: 'server_not_ready' });
      return reply({ url: `http://127.0.0.1:${port}` });
    });
    mcpServer.registerTool('stop_watcher', {
      description: 'Stop the managed Session Watcher server.',
      inputSchema: SessionIdSchema,
      annotations: { readOnlyHint: true },
    }, async ({ sessionId: _sid } = {}) => {
      probeCall('stop_watcher', { sessionId: _sid });
      return reply({ noop: true, note: 'in-process mode — server lifecycle is tied to the CC session. Restart the session to reload code.' });
    });
    mcpServer.registerTool('watcher_status', {
      description: 'Report whether the Session Watcher server is running and its URL.',
      inputSchema: SessionIdSchema,
      annotations: { readOnlyHint: true },
    }, async ({ sessionId: _sid } = {}) => {
      probeCall('watcher_status', { sessionId: _sid });
      const port = server.address()?.port;
      if (!port) return reply({ running: false });
      return reply({ running: true, url: `http://127.0.0.1:${port}` });
    });
    mcpServer.registerTool('get_bucket_summary', {
      description: 'Return the current context bucket structure (files, skills, tools) plus a compact metrics snapshot, so the agent can decide what to carry over before /clear.',
      inputSchema: SessionIdSchema,
      annotations: { readOnlyHint: true },
    }, async ({ sessionId: _sid } = {}) => {
      probeCall('get_bucket_summary', { sessionId: _sid });
      return reply(await inprocFetch('/api/buckets'));
    });
    mcpServer.registerTool('prepare_handoff', {
      description: 'Persist a keep/discard decision + structured summary before /clear; returns a human-readable token to restore context in the next segment.',
      inputSchema: {
        ...SessionIdSchema,
        paths_to_keep: z.array(z.object({
          path: z.string().describe('File path (project-relative)'),
          symbols: z.array(z.string()).optional().describe('Key symbols to focus on in this file (function/class names)'),
        })).describe('Files to carry over with optional symbol hints; lines are auto-populated by the server from B_rebuild data'),
        skills_to_keep: z.array(z.string()).optional().describe('Skill names to carry over (e.g. "systematic-debugging", "brainstorming")'),
        load_token: z.string().optional().describe('Existing token to update in place (idempotent re-issue); omit to create new'),
        summary: z.string().describe('Structured summary of current work state'),
        next_task: z.string().optional().describe('What comes next'),
        observed_segment: z.number().int().optional().describe('Segment index from get_bucket_summary, for a consistency check'),
      },
      annotations: { readOnlyHint: false },
    }, async ({ sessionId: _sid, ...input } = {}) => {
      probeCall('prepare_handoff', { sessionId: _sid });
      return reply(await inprocFetch('/api/handoff/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }));
    });
    mcpServer.registerTool('load_handoff', {
      description: 'Retrieve a prepared handoff package by token, by free-text search, or by same-session auto-match. Pure read.',
      inputSchema: {
        ...SessionIdSchema,
        load_token: z.string().optional().describe('Semantic token from prepare_handoff (exact match)'),
        query: z.string().optional().describe('Free-text search when the token is unknown; returns top matches'),
        query_mode: z.enum(['plain', 'advanced']).optional().describe('plain (default) escapes input; advanced passes raw FTS5 syntax'),
      },
      annotations: { readOnlyHint: true },
    }, async ({ sessionId: _sid, ...input } = {}) => {
      probeCall('load_handoff', { sessionId: _sid });
      const qs = new URLSearchParams(Object.entries(input).filter(([, v]) => v != null)).toString();
      return reply(await inprocFetch(`/api/handoff/load${qs ? '?' + qs : ''}`));
    });

    mcpServer.registerTool('rotate_session', {
      description: 'Rotate the watcher to a new session (fallback for hook HTTP failure).',
      inputSchema: {
        session_id: z.string().describe('The NEW session ID'),
        transcript_path: z.string().optional().describe('Explicit transcript path'),
      },
      annotations: { readOnlyHint: false },
    }, async ({ session_id, transcript_path }) => {
      return reply(doRotation(session_id, transcript_path));
    });

    await mcpServer.connect(new StdioServerTransport());
    console.error('session-watcher MCP server ready');
  }
}
