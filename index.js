#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// Re-export launcher functions for backward compatibility (tests, manual usage)
export { stateFileFor, resolveProjectDir, sessionIdOf, probeHealth, fetchHealth, readState, startWatcher, stopWatcher, watcherStatus } from './lib/launcher.js';

// MCP wiring — only when run as the entrypoint (not when imported by tests).
// Use realpath to handle symlinks (e.g. devcontainer plugin cache symlink).
const __selfReal = realpathSync(fileURLToPath(import.meta.url));
const __argvReal = (() => { try { return realpathSync(process.argv[1]); } catch { return ''; } })();
if (__selfReal === __argvReal) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const { startWatcher, stopWatcher, watcherStatus } = await import('./lib/launcher.js');
  const server = new McpServer({ name: 'session-watcher', version: '0.4.0' });

  const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

  const SessionIdSchema = { sessionId: z.string().optional().describe('Override session ID (used when resume changes the ID)') };

  server.registerTool('start_watcher', {
    description: 'Start (or reuse) the Session Watcher dashboard server; returns its URL. Never returns metric values.',
    inputSchema: { ...SessionIdSchema, transcript: z.string().optional().describe('Explicit transcript .jsonl path (overrides session ID lookup)') },
    annotations: { readOnlyHint: true },
  }, async ({ sessionId, transcript } = {}) => {
    const env = sessionId ? { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } : process.env;
    return reply(await startWatcher(env, { transcript }));
  });
  server.registerTool('stop_watcher', {
    description: 'Stop the managed Session Watcher server.',
    inputSchema: SessionIdSchema,
    annotations: { readOnlyHint: true },
  }, async ({ sessionId } = {}) => {
    const env = sessionId ? { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } : process.env;
    return reply(await stopWatcher(env));
  });
  server.registerTool('watcher_status', {
    description: 'Report whether the Session Watcher server is running and its URL.',
    inputSchema: SessionIdSchema,
    annotations: { readOnlyHint: true },
  }, async ({ sessionId } = {}) => {
    const env = sessionId ? { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId } : process.env;
    return reply(await watcherStatus(env));
  });

  await server.connect(new StdioServerTransport());
  console.error('session-watcher MCP server ready');
}
