#!/usr/bin/env node
// Re-export launcher functions for backward compatibility (tests, manual usage)
export { stateFileFor, resolveProjectDir, sessionIdOf, probeHealth, fetchHealth, readState, startWatcher, stopWatcher, watcherStatus } from './lib/launcher.js';

// MCP wiring — only when run as the entrypoint (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const { startWatcher, stopWatcher, watcherStatus } = await import('./lib/launcher.js');
  const server = new McpServer({ name: 'session-watcher', version: '0.3.0' });

  const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  server.registerTool('start_watcher', { description: 'Start (or reuse) the Session Watcher dashboard server; returns its URL. Never returns metric values.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(await startWatcher()));
  server.registerTool('stop_watcher', { description: 'Stop the managed Session Watcher server.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(await stopWatcher()));
  server.registerTool('watcher_status', { description: 'Report whether the Session Watcher server is running and its URL.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(await watcherStatus()));

  await server.connect(new StdioServerTransport());
  console.error('session-watcher MCP server ready');
}
