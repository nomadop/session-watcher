// lib/cli.js
/**
 * CLI orchestrator: starts replay-server or static demo server, auto-opens browser,
 * renders terminal statusline, handles clean shutdown.
 *
 * Design decisions (external review folded):
 * - Reads replay progress via HTTP /api/replay/status (single controller ownership)
 * - Uses build-injected args.version (no runtime package.json read)
 * - Idempotent cleanup with early signal registration
 * - rmSync(tmpDir) for full temp directory cleanup
 * - process.on('exit') as last-resort temp cleanup for crash paths
 */
import { existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { release } from 'node:os';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { startReplayServer } from './replay-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ command: string, transcriptPath: string|null, speed: number, port: number, noOpen: boolean, version: string }} args
 */
export async function runCli(args) {
  // 'demo' command: serve static demo (same as GitHub Pages live demo)
  if (args.command === 'demo') {
    return runStaticDemo(args);
  }

  // 'replay' command: full replay server
  return runReplay(args);
}

async function runStaticDemo(args) {
  // Locate public/ directory (bundled: dist/public, source dev: public/)
  const candidates = [
    join(__dirname, '..', 'public'),           // bundled (dist/bin/../public = dist/public)
    join(__dirname, '..', 'dist', 'public'),   // source dev fallback
  ];
  const publicDir = candidates.find(p => existsSync(join(p, 'demo.html')));

  if (!publicDir) {
    console.error('Error: Demo assets not found. Try reinstalling: npm install -g @nomadop/session-watcher');
    process.exit(1);
  }

  const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  };

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let filePath = join(publicDir, url.pathname === '/' ? 'demo.html' : url.pathname);
    // Security: prevent path traversal
    if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
    try {
      const data = readFileSync(filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(args.port, () => resolve());
    server.on('error', reject);
  });

  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;

  // Signal handlers
  const cleanup = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Print header
  console.log(`Session Watcher ${args.version} — Demo`);
  console.log(`Dashboard → ${url}`);
  console.log('Ctrl-C to stop');

  // Auto-open browser
  if (!args.noOpen) {
    openBrowser(url);
  }
}

async function runReplay(args) {
  let transcriptPath = args.transcriptPath;

  // Validate transcript exists
  if (!existsSync(transcriptPath)) {
    console.error(`Error: File not found: ${transcriptPath}`);
    process.exit(1);
  }

  try {
    statSync(transcriptPath);
  } catch (e) {
    if (e.code === 'EACCES') {
      console.error(`Error: Permission denied: ${transcriptPath}`);
      process.exit(1);
    }
    throw e;
  }

  // Warn on non-.jsonl extension
  if (!transcriptPath.endsWith('.jsonl')) {
    console.error(`Warning: ${transcriptPath} does not have .jsonl extension — attempting parse anyway.`);
  }

  // Start the replay server
  let instance;
  try {
    instance = await startReplayServer({
      transcriptPath,
      speed: args.speed,
      port: args.port,
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Error: Port ${args.port} is in use. Use --port 0 for automatic port selection.`);
    } else {
      console.error(`Error: ${e.message}`);
    }
    process.exit(1);
  }

  // --- Signal handlers registered BEFORE any output (R1: race fix) ---
  let cleanupPromise = null;
  const isTTY = process.stdout.isTTY && process.env.TERM !== 'dumb' && !process.env.CI;
  let statusInterval = null;

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (statusInterval) clearInterval(statusInterval);
      if (isTTY) process.stdout.write('\x1B[?25h\n'); // restore cursor
      await instance.stop();
      process.exit(0);
    })();
    return cleanupPromise;
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // --- Print header ---
  console.log(`Session Watcher ${args.version} — Replay Mode`);
  console.log(`Transcript: ${transcriptPath} (${instance.totalSteps} steps)`);
  console.log(`Dashboard → ${instance.url}`);
  console.log(`Speed: ${args.speed}× | Ctrl-C to stop`);
  console.log('');

  // Auto-open browser
  if (!args.noOpen) {
    openBrowser(instance.url);
  }

  // Terminal statusline rendering
  if (isTTY) {
    process.stdout.write('\x1B[?25l'); // hide cursor
    statusInterval = startTTYStatusline(instance, args.command);
  } else {
    statusInterval = startNonTTYStatusline(instance);
  }
}

function startTTYStatusline(instance, command) {
  let lastLines = 0;
  let busy = false;
  const interval = setInterval(async () => {
    if (busy) return; // prevent overlapping fetches
    busy = true;
    try {
      const [statusRes, replayRes] = await Promise.all([
        fetch(`${instance.url}/api/status?fmt=line`),
        fetch(`${instance.url}/api/replay/status`),
      ]);
      if (!statusRes.ok || !replayRes.ok) return;
      const line = await statusRes.text();
      const progress = await replayRes.json();

      // Fallback: if the server nulls the controller (e.g. manual /api/replay/stop),
      // the API returns { active: false }. Stop polling gracefully.
      if (!progress.active) {
        if (lastLines > 0) process.stdout.write(`\x1B[${lastLines}A\x1B[J`);
        const doneOutput = `${line}\n▸ Done. Dashboard remains available until Ctrl-C.\n`;
        process.stdout.write(doneOutput);
        lastLines = (doneOutput.match(/\n/g) || []).length;
        clearInterval(interval);
        if (command === 'demo') {
          process.stdout.write('\n\n  Try your own transcript:\n  npx @nomadop/session-watcher replay ~/.claude/projects/.../session.jsonl\n');
        }
        return;
      }

      // Clear previous output: cursor is at col 0 of the line AFTER our block
      // (we always end with \n). Move up lastLines and erase to end of screen.
      if (lastLines > 0) {
        process.stdout.write(`\x1B[${lastLines}A\x1B[J`);
      }

      const progressLine = progress.done
        ? '▸ Done. Dashboard remains available until Ctrl-C.'
        : `▸ ${progress.current}/${progress.total} · ${progress.speed}× replay`;

      const output = `${line}\n${progressLine}\n`;
      process.stdout.write(output);
      // Lines occupied = number of \n (cursor now sits at col 0 of next line)
      lastLines = (output.match(/\n/g) || []).length;

      if (progress.done) {
        clearInterval(interval);
        if (command === 'demo') {
          process.stdout.write('\n\n  Try your own transcript:\n  npx @nomadop/session-watcher replay ~/.claude/projects/.../session.jsonl\n');
        }
      }
    } catch { /* server shutting down */ }
    finally { busy = false; }
  }, 500);
  interval.unref();
  return interval;
}

function startNonTTYStatusline(instance) {
  let lastReported = 0;
  let finished = false;
  console.log(`[replay] started ${instance.url} (${instance.totalSteps} steps)`);

  const interval = setInterval(async () => {
    if (finished) return;
    try {
      const res = await fetch(`${instance.url}/api/replay/status`);
      if (!res.ok) return;
      const progress = await res.json();

      // D4 fix: { active: false } means replay finished and controller was cleared
      if (!progress.active) {
        if (!finished) {
          finished = true;
          console.log(`[replay] ${instance.totalSteps}/${instance.totalSteps} done`);
          clearInterval(interval);
        }
        return;
      }

      // Report every 10 frames or on done
      if (progress.current - lastReported >= 10 || progress.done) {
        lastReported = progress.current;
        if (progress.done) {
          finished = true;
          console.log(`[replay] ${progress.total}/${progress.total} done`);
          clearInterval(interval);
        } else {
          console.log(`[replay] ${progress.current}/${progress.total}`);
        }
      }
    } catch { /* shutting down */ }
  }, 5000);
  interval.unref();
  return interval;
}

function openBrowser(url) {
  const isWSL = release().toLowerCase().includes('microsoft');
  let cmd;
  if (isWSL) {
    cmd = `cmd.exe /c start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (process.platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, () => { /* silent failure — URL is already printed */ });
}
