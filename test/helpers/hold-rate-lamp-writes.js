// Loaded into a spawned owner through `--import`, it replaces the coalesced write-behind's scheduler with one
// that never fires on its own. SIGUSR2 runs that flush once and then writes the file SW_TEST_FLUSH_MARK
// names, so a test can place a checkpoint where it wants one and know that nothing else writes the ledger
// until the owner's own shutdown path does.
import { writeFileSync } from 'node:fs';
import { _setRateLampManagerTestHooks } from '../../lib/rate-lamp-manager.js';

let flush = null;
_setRateLampManagerTestHooks({ scheduler: (fn) => { flush = fn; return {}; } });
process.on('SIGUSR2', () => {
  if (flush) flush();
  writeFileSync(process.env.SW_TEST_FLUSH_MARK, flush ? 'flushed' : 'nothing-scheduled');
});
