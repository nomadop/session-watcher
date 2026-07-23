// lib/parse-args.js
// Pure argv parser — zero upstream imports (only node:path).
// Testable in isolation before any other task is implemented.
import { resolve } from 'node:path';

export function parseCliArgs(argv) {
  const result = { command: 'help', transcriptPath: null, speed: 20, port: 0, noOpen: false, error: null };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { ...result, command: 'help' };
    if (argv[i] === '--version' || argv[i] === '-V') return { ...result, command: 'version' };
    if (argv[i] === '--speed' && argv[i + 1]) {
      i++;
      const n = parseFloat(argv[i]);
      result.speed = (Number.isFinite(n) && n > 0) ? n : 0.1;
      continue;
    }
    if (argv[i] === '--port' && argv[i + 1]) {
      i++;
      const p = parseInt(argv[i], 10);
      result.port = (Number.isFinite(p) && p >= 0 && p <= 65535) ? p : 0;
      continue;
    }
    if (argv[i] === '--no-open') { result.noOpen = true; continue; }
    if (!argv[i].startsWith('-')) positional.push(argv[i]);
  }

  const cmd = positional[0];
  if (cmd === 'demo') {
    result.command = 'demo';
  } else if (cmd === 'replay') {
    result.command = 'replay';
    if (positional[1]) {
      result.transcriptPath = resolve(positional[1]);
    } else {
      result.error = 'replay requires a transcript path';
    }
  } else if (cmd) {
    result.command = 'help';
  }

  return result;
}
