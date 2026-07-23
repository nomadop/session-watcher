// Lifecycle probe — lightweight instrumentation for statusline/hook/MCP.
// Activated by SW_PROBE=1 environment variable. Zero cost when off.
// Writes append-only NDJSON to ~/.session-watcher/lifecycle-probe.jsonl
//
// Analyze: node references/analysis-scripts/lifecycle-probe.mjs analyze
// Snapshot: node references/analysis-scripts/lifecycle-probe.mjs snapshot
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ACTIVE = process.env.SW_PROBE === '1';
const STATE_DIR = process.env.SW_STATE_DIR || join(homedir(), '.session-watcher');
const PROBE_LOG = join(STATE_DIR, 'lifecycle-probe.jsonl');

// Dedup: only log statusline when state changes or every SAMPLE_INTERVAL_MS.
// Uses a tiny sidecar file per session_id (avoids reading the full NDJSON).
const SAMPLE_INTERVAL_MS = 300_000; // 5 min for steady-state repeats
const DEDUP_DIR = join(STATE_DIR, 'probe-dedup');

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

function emit(source, data) {
  if (!ACTIVE) return;
  const line = JSON.stringify({ ts: Date.now(), source, ...data }) + '\n';
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(PROBE_LOG, line);
  } catch { /* probe must never fail loudly */ }
}

// ── Statusline probe ─────────────────────────────────────────────────────────
// Call from statusline.js after parsing stdin, before fetching status.
// Deduplicates: only logs on state change or every 5 min (whichever first).
export function probeStatusline({ session_id, transcript_path, cwd, model, port, stateFileKey, stateTranscript }) {
  if (!ACTIVE) return;
  let serverAlive = false;
  if (port) {
    try {
      const sf = readStateFile(stateFileKey || session_id);
      if (sf && sf.pid) serverAlive = isPidAlive(sf.pid);
    } catch {}
  }
  const transcriptMatch = stateTranscript && transcript_path
    ? stateTranscript === transcript_path : null;

  // Dedup: hash the state-relevant fields; skip if unchanged and recent.
  // Persisted in a tiny sidecar file (statusline is a short-lived process each invocation).
  const hash = [!!port, serverAlive, transcriptMatch, stateFileKey || ''].join(',');
  const now = Date.now();
  const dedupFile = join(DEDUP_DIR, (session_id || 'x').slice(0, 12));
  try {
    const raw = readFileSync(dedupFile, 'utf8');
    const sepIdx = raw.lastIndexOf('\t');
    if (sepIdx > 0 && raw.slice(0, sepIdx) === hash && (now - Number(raw.slice(sepIdx + 1))) < SAMPLE_INTERVAL_MS) return;
  } catch { /* first time or unreadable — proceed */ }
  try { mkdirSync(DEDUP_DIR, { recursive: true }); writeFileSync(dedupFile, `${hash}\t${now}`); } catch {}

  emit('statusline', {
    session_id: session_id?.slice(0, 12),
    transcript: transcript_path ? transcript_path.split('/').slice(-2).join('/') : '',
    cwd: cwd ? cwd.split('/').slice(-2).join('/') : '',
    model: model || '',
    portFound: !!port,
    port: port || null,
    stateFileKey: stateFileKey?.slice(0, 12) || null,
    transcriptMatch,
    serverAlive,
  });
}

// ── SessionStart hook probe ──────────────────────────────────────────────────
// Call from hooks/session-start.js after parsing stdin, before launching.
export function probeHook({ session_id, source, transcript_path, cwd }) {
  if (!ACTIVE) return;
  let existingCount = 0, aliveCount = 0;
  try {
    const files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json') && !f.includes('probe'));
    existingCount = files.length;
    for (const f of files) {
      try {
        const sf = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
        if (sf.pid && isPidAlive(sf.pid)) aliveCount++;
      } catch {}
    }
  } catch {}
  emit('hook', {
    session_id: session_id?.slice(0, 12),
    hook_source: source,
    transcript: transcript_path ? transcript_path.split('/').slice(-2).join('/') : '',
    cwd: cwd ? cwd.split('/').slice(-2).join('/') : '',
    existingStateFiles: existingCount,
    aliveServers: aliveCount,
    env_session_id: process.env.CLAUDE_CODE_SESSION_ID?.slice(0, 12) || null,
  });
}

// ── Handoff discovery probe ──────────────────────────────────────────────────
// Call from hooks/session-start.js after discoverHandoffs() returns (or throws).
export function probeHandoffDiscovery({ dbPath, projectId, sessionId, rowCount, error }) {
  if (!ACTIVE) return;
  emit('hook_discovery', {
    dbPath: dbPath || null,
    projectId: projectId || null,
    session_id: sessionId?.slice(0, 12) || null,
    rowCount: rowCount ?? null,
    error: error || null,
  });
}

// ── MCP tool call probe ──────────────────────────────────────────────────────
// Call from index.js in the reply() wrapper or each tool handler.
export function probeMcp({ tool, sessionIdArg, envSessionId, serverSessionId, serverTranscript }) {
  if (!ACTIVE) return;
  emit('mcp', {
    tool,
    session_id_env: envSessionId?.slice(0, 12) || null,
    session_id_arg: sessionIdArg?.slice(0, 12) || null,
    server_session_id: serverSessionId?.slice(0, 12) || null,
    server_transcript: serverTranscript ? serverTranscript.split('/').slice(-2).join('/') : null,
    pid: process.pid,
  });
}

function readStateFile(key) {
  if (!key) return null;
  try { return JSON.parse(readFileSync(join(STATE_DIR, `${key}.json`), 'utf8')); }
  catch { return null; }
}
