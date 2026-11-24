// The read guard over the real DSH loop of the checkout `SW_DSH_CHECKOUT` names, through the built host entry (`test/helpers/dsh-shipped-entry.js`). Without the checkout every case skips.
import test from 'node:test';

import { runShippedScenario, shippedEntrySkip } from './helpers/dsh-shipped-entry.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const GUARD = { child: 'dsh-read-guard-child.js', skip: shippedEntrySkip(CHECKOUT), timeout: 180_000 };

test('over a sealed session a read of lines the carrier holds and the disk has not changed is answered with the error and recorded between the call and its result, the edit that follows goes through on the read\'s own observation, and a rewritten file, a file never read and a relative path are each read or blocked as the lines they return decide', GUARD, (t) => {
  runShippedScenario(t, 'read-guard-sealed', CHECKOUT, GUARD);
});

test('with the mode off no read is answered with the error however many times the same lines are read', GUARD, (t) => {
  runShippedScenario(t, 'read-guard-off', CHECKOUT, GUARD);
});
