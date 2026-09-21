#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { probeMcp } from './lib/probe.js';
import { PLUGIN_VERSION } from './lib/version.js';
import { HISTORY_EXCERPT_CHARS } from './lib/turn-history-budget.js';
import { TURN_ADDRESS_RE, TURN_PAGE_BOUNDARY_RE } from './lib/turn.js';
// Re-export launcher functions for backward compatibility (tests, manual usage)
export { stateFileFor, resolveProjectDir, sessionIdOf, probeHealth, fetchHealth, readState, startWatcher, stopWatcher, watcherStatus, getBucketSummary, prepareHandoff, loadHandoff, rotateSession } from './lib/launcher.js';

// Turn history read surface. All three resolve their own lineage from the newest handoff delivered
// into this session, so none takes a lineage identifier: a caller that never loaded a handoff gets
// no_handoff_loaded instead of a guessable integer. Keeping this registration in index.js follows the
// project's single-file MCP-host rule; exporting the bounded helper lets tests use the real SDK without
// spawning stdio or starting the dashboard.
export function registerTurnReadTools({ mcpServer, z, turnReadService, reply }) {
  const nonBlank = (v) => v.trim() !== '';

  mcpServer.registerTool('turn_page', {
    description: 'Read a page of the history turns carried by the handoff loaded into this session, newest first.',
    inputSchema: {
      before: z.string().regex(TURN_PAGE_BOUNDARY_RE).optional().describe(
        'Where to read back from: an S{k}:{T} cursor from the next_before of the handoff load reply or of a '
        + 'previous page, which ends the page before that turn; or a bare S{k} session label from the load '
        + 'reply\'s lineage, which starts at that session\'s end. Omit for the newest page.'),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => reply(turnReadService.turnPage(input || {})));

  mcpServer.registerTool('turn_search', {
    description: 'Find a known literal in the transcripts behind the handoff loaded into this session: behaves as '
      + 'grep -F -i -n over them, limited to the active path. Returns one entry per turn the literal landed in, '
      + 'oldest to newest.',
    inputSchema: {
      q: z.string().min(1).max(HISTORY_EXCERPT_CHARS).refine(nonBlank).describe(
        'An exact literal, matched as a case-folded ASCII substring with no tokenization: spacing, punctuation and '
        + 'CJK must match the transcript exactly. A shorter literal reaches more turns, a longer one fewer. Use '
        + 'turn_locate when the wording is uncertain.'),
      scope: z.string().regex(TURN_ADDRESS_RE).optional().describe(
        'An S{k}:{T} from turn_locate or from a search entry, narrowing the search to that one turn. Omit to cover '
        + 'the whole lineage.'),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => reply(turnReadService.turnSearch(input || {})));

  mcpServer.registerTool('turn_locate', {
    description: 'Find which turns of the loaded handoff mention a remembered term, when the source wording is '
      + 'unknown. Returns entries oldest to newest, each carrying its turn\'s S{k}:{T} scope.',
    inputSchema: {
      q: z.string().min(1).max(HISTORY_EXCERPT_CHARS).refine(nonBlank).describe(
        'One distinctive term, a file path, or a note. Resolved through FTS5 — words are ANDed and CJK is '
        + 'split into bigrams, so a longer phrase narrows toward zero matches.'),
    },
    annotations: { readOnlyHint: true },
  }, async (input) => reply(turnReadService.turnLocate(input || {})));
}

// MCP wiring — only when run as the entrypoint (not when imported by tests).
// Use realpath to handle symlinks (e.g. devcontainer plugin cache symlink).
const __selfReal = realpathSync(fileURLToPath(import.meta.url));
const __argvReal = (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (__selfReal === __argvReal) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const { withLoadRecovery } = await import('./lib/turn-tool-recovery.js');

  // ── In-process watcher + Express server ──────────────────────────────────
  // MCP tools delegate to the in-process server via loopback fetch.
  {
    const { createServer, createWatcherComposition, resolveBySessionId, PORT_DIR } = await import('./server.js');
    const { initStore, closeStoreGlobal, getStore } = await import('./lib/store.js');
    const { flushAll } = await import('./lib/rate-lamp-manager.js');

    const { resolveProjectKey } = await import('./lib/project-key.js');
    const { loadIsIgnored } = await import('./gitignore-loader.js');
    const { resolveClaudeCodeCacheTtl } = await import('./lib/harness/claude-code/cache-ttl.js');

    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || 'default';
    const projectsRoot = join(homedir(), '.claude', 'projects');
    // NO /dev/null fallback: an unresolved locator is null, and the host's own acquisition retries it on
    // every poll tick until Claude Code has written the file.
    const transcriptPath = resolveBySessionId(projectsRoot, sessionId);
    const cwd = process.cwd();
    const projectId = resolveProjectKey({ claudeProjectDir: process.env.CLAUDE_PROJECT_DIR, cwd });
    // effectiveStateDir mirrors createServer's own resolution (stateDir || PORT_DIR)
    const effectiveStateDir = process.env.SW_STATE_DIR || PORT_DIR;

    // Store BEFORE the composition and before bootstrap: the shared application takes the store as a
    // required construction dependency, and the synchronous bootstrap inside createServer archives any
    // segment the Source already closed — with replay provenance, because those epochs already ended.
    try { initStore(); } catch (e) { console.error('[session-watcher] fatal: store init failed —', e.message); process.exit(1); }

    // The harness spawns this MCP host as a child process, so its environment carries the harness's own
    // prompt-cache declaration and reading it here reads the declaration that prices these calls. One read,
    // handed to the composition that measures under it and to the application that reports its price.
    const cacheTtl = resolveClaudeCodeCacheTtl();
    const watcher = createWatcherComposition({
      sessionId, sourceLocator: transcriptPath, projectId, projectRoot: cwd,
      stateDir: effectiveStateDir, store: getStore(), isIgnored: loadIsIgnored(cwd),
      cacheTtl,
    });

    let cleanup;   // forward-declared: the owner-fatal sink and the signal handlers all call it
    // One owner-fatal sink shared by post-bootstrap polling and rotation: report, run non-finalizing
    // cleanup, exit nonzero. The current segment is deliberately NOT finalized — the failure means the
    // application refused a transition, so a fresh owner rebuilds it from the Source instead.
    const failOwner = (error) => {
      console.error('[session-watcher] fatal:', error?.message || error);
      try { cleanup({ finalizeCurrentSegment: false }); } catch { /* cleanup is best-effort here */ }
      process.exit(1);
    };

    // A synchronous bootstrap acquisition or application error throws out of createServer and prevents owner
    // startup. Startup-failure cleanup also skips current-segment finalization.
    let handle;
    try {
      handle = createServer({
        watcher,
        pollIntervalMs: 1000,
        sessionId,
        projectsRoot,
        projectRoot: cwd,
        projectId,
        sourceLocator: transcriptPath,
        stateDir: process.env.SW_STATE_DIR || null,
        cacheTtl,
        onOwnerFatal: failOwner,
      });
    } catch (error) {
      console.error('[session-watcher] fatal: owner startup failed —', error?.message || error);
      try { closeStoreGlobal(); } catch { /* nothing durable to lose */ }
      process.exit(1);
    }
    const {
      server, startPolling, sseClients, stopTimers, doRotation,
      turnService, turnReadService, publishDiscovery, publishedDiscoveryPaths, closeCurrentSegment,
    } = handle;

    // ONE idempotent cleanup. Its ORDER is fixed; its trigger selects only whether the current segment is
    // finalized. Normal shutdown finalizes; startup failure, owner-fatal and the process-exit fallback do
    // not. A finalization or flush failure does not stop the later steps — the Store must still close.
    let cleaned = false;
    cleanup = ({ finalizeCurrentSegment = true } = {}) => {
      if (cleaned) return;
      cleaned = true;
      // 1. Stop ingress and timers.
      stopTimers();
      for (const c of sseClients) { try { c.end(); } catch { /* already destroyed */ } }
      sseClients.clear();
      // 2. Terminal application finalization, when this trigger asks for it.
      if (finalizeCurrentSegment) {
        try { closeCurrentSegment({ captureMode: 'live' }); }
        catch (e) { if (process.env.SW_DEBUG) console.error('[cleanup finalize]', e?.message || e); }
      }
      // 3. Rate Lamp checkpoint, while the Store is still open: the coalesced write-behind may hold progress
      // that has not fired, and a restart must not integrate historical samples to recover it.
      try { flushAll(); } catch (e) { if (process.env.SW_DEBUG) console.error('[cleanup flush]', e?.message || e); }
      // 4. Close Store, SSE and discovery.
      try { closeStoreGlobal(); } catch (e) { if (process.env.SW_DEBUG) console.error('[cleanup store]', e?.message || e); }
      // Only the paths this owner actually published, and only after the pid check: a path derived from the
      // current session id could name a record a live sibling owns after a failed rotation publication.
      for (const stateFile of publishedDiscoveryPaths()) {
        try {
          const st = JSON.parse(readFileSync(stateFile, 'utf8'));
          if (st.pid === process.pid) unlinkSync(stateFile);
        } catch { /* already gone, or another owner's */ }
      }
    };

    // SIGTERM and SIGINT bypass the grace period, run the same cleanup once, and exit normally.
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    // The process-exit fallback does NOT finalize: by the time it runs an explicit path has usually already
    // owned the result through the `cleaned` guard, and an uncaught exit is not a clean segment end.
    process.on('exit', () => cleanup({ finalizeCurrentSegment: false }));

    // stdin EOF grace period: keep the owner alive after CC disconnects stdio, so /resume within that window
    // still finds the discovery record and a working port. HTTP, discovery, polling and rotation all stay
    // ACTIVE until the timer expires. The first EOF starts it; later EOFs do nothing.
    const STDIN_GRACE_MS = Number(process.env.SW_GRACE_MS) || 2 * 60 * 60 * 1000; // default 2 hours
    let stdinEnded = false;
    process.stdin.on('end', () => {
      if (stdinEnded) return;
      stdinEnded = true;
      console.error(`[session-watcher] stdin EOF — grace period started (${STDIN_GRACE_MS / 60000}min)`);
      setTimeout(() => { cleanup(); process.exit(0); }, STDIN_GRACE_MS).unref();
    });

    server.listen(0, '127.0.0.1', () => {
      mkdirSync(effectiveStateDir, { recursive: true });
      handle.applyEffectiveRatio();
      // Listen-time discovery creation. Its FAILURE prevents owner startup and runs owner cleanup without
      // finalizing the current segment: an owner no consumer can find is worse than no owner, and the
      // segment it would archive is still intact in the Source for the next one to rebuild.
      const published = publishDiscovery();
      if (!published.ok) {
        console.error('[session-watcher] fatal: discovery state file could not be created —', published.error?.message);
        cleanup({ finalizeCurrentSegment: false });
        process.exit(1);
      }
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
      return reply(await inprocFetch('/api/buckets?symbols=1'));
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
        load_token: z.string().optional().describe('Existing token to revise; kept if undelivered, replaced by a new token if already delivered. Omit to create new'),
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
      description: 'Retrieve a prepared handoff package by token, by free-text search, or — with neither given — '
        + 'by auto-match over undelivered handoffs of this project from other sessions. A retrieved package carries '
        + 'the lineage behind it as one headline per session, oldest to newest, beside the newest page of its '
        + 'turns. Pure read.',
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
      return reply(withLoadRecovery(await inprocFetch(`/api/handoff/load${qs ? '?' + qs : ''}`)));
    });

    // Turn queue capture. Both tools call the in-process turnService directly (no HTTP route exists for
    // them), and both omit probeCall / SessionIdSchema — the capture is bound to this process's own
    // watcher, so an overridden session id would name a transcript it cannot read. submit_turn_notes
    // returns its four expected failures as data; anything else propagates as a standard MCP error
    // rather than a fifth response shape.
    mcpServer.registerTool('get_turn_skeleton', {
      description: 'Write the current context epoch to a turn skeleton file and a notes file whose `## NOTE[T]` headings are the slot set, and return both paths, the snapshot id to submit against, and the protocol for filling them.',
      inputSchema: {},
      // Not read-only: it creates a directory under the state dir and writes both files. A client that
      // auto-approves read-only tools must not reach this without asking.
      annotations: { readOnlyHint: false },
    }, async () => reply(turnService.getTurnSkeleton()));

    mcpServer.registerTool('submit_turn_notes', {
      description: 'Commit the notes file the latest get_turn_skeleton wrote. The server locates that file itself, so no note text crosses the wire. All-or-nothing: every NOTE slot must be covered — by a section in the notes file or by a row the store already holds for that turn — and the snapshot must still be current.',
      inputSchema: {
        snapshot_id: z.string().describe('snapshot_id from get_turn_skeleton'),
      },
      annotations: { readOnlyHint: false },
    }, async (input) => reply(await turnService.submitTurnNotes(input)));

    registerTurnReadTools({ mcpServer, z, turnReadService, reply });

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
