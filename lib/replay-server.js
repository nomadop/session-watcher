// lib/replay-server.js
/**
 * Replay-only server: stripped createServer() for CLI use.
 * - In-memory SQLite (no disk writes)
 * - No port-discovery state files
 * - No live poll timer
 * - No hook installation
 * - Auto-starts replay via POST /api/replay/start on server ready
 * - Single ReplayController ownership: server's internal _replayController closure
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionWatcher } from './watcher.js';
import { indexTranscript } from './replay.js';
import { createServer } from '../server.js';
import { initStore, closeStoreGlobal } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ transcriptPath: string, speed?: number, port?: number }} opts
 * @returns {Promise<{ server: import('http').Server, url: string, totalSteps: number, stop: () => Promise<void> }>}
 */
export async function startReplayServer({ transcriptPath, speed = 20, port = 0 }) {
  // Validate transcript has usage events BEFORE allocating resources
  const index = indexTranscript(transcriptPath);
  if (index.length === 0) {
    throw new Error(`No usage events found in ${transcriptPath}. Session Watcher 0.5.4 supports Claude Code JSONL transcripts only.`);
  }

  // In-memory store — zero disk footprint
  initStore(':memory:');

  let cleanedUp = false;

  // Create watcher pointed at the transcript
  const watcher = new SessionWatcher(transcriptPath, null, { cwd: process.cwd() });

  // D3 fix: resolve publicDir relative to THIS file's location.
  // In source mode: lib/ → ../public (= ROOT/public).
  // In bundle: dist/bin/ → ../public (= dist/public, which build copies there).
  const publicDir = join(__dirname, '..', 'public');

  // Create the HTTP server (reuses existing createServer factory)
  // DO NOT call startPolling() — pollIntervalMs=0 disables it
  // DO NOT write state files (port-discovery happens in server.js's CLI entry, not createServer)
  const { server, stopTimers, sseClients } = createServer({
    watcher,
    pollIntervalMs: 0,
    sessionId: 'replay',
    hookSessionId: null,
    onIdleShutdown: null,
    projectsRoot: null,
    stateDir: null,
    publicDir,
    disableTelemetrySweep: true,
  });

  // Listen — reject on EADDRINUSE or other bind errors
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;

  // Start replay via the server's own API endpoint — this creates and starts
  // the SINGLE ReplayController inside createServer's closure. The `transcript`
  // field tells it which file to replay (same as dashboard replay button uses).
  const startRes = await fetch(`${url}/api/replay/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: transcriptPath, speed }),
  });
  if (!startRes.ok) {
    const err = await startRes.json().catch(() => ({}));
    // Cleanup on startup failure
    closeStoreGlobal();
    server.close();
    throw new Error(`Failed to start replay: ${err.error || startRes.statusText}`);
  }

  // Idempotent stop() for clean shutdown
  const stop = () => {
    if (cleanedUp) return Promise.resolve();
    cleanedUp = true;
    return new Promise((resolve) => {
      // Stop replay via API (stops the controller's timer)
      fetch(`${url}/api/replay/stop`, { method: 'POST' }).catch(() => {});
      stopTimers();
      for (const client of sseClients) { try { client.end(); } catch {} }
      server.close(() => {
        closeStoreGlobal();
        resolve();
      });
      // Force-resolve after 2s if server.close hangs (e.g. dangling connections)
      setTimeout(() => { closeStoreGlobal(); resolve(); }, 2000).unref();
    });
  };

  return { server, url, totalSteps: index.length, stop };
}
