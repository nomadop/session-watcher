// The inner seal's quote (`lib/inner-seal/quote.js`): the estimate of the current A and the bounded decision over it, read through the module's own functions. The expected values are worked examples computed apart from the module.
import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateInnerA, INNER_QUOTE, innerQuote as quoteUnder, isQuote, KAPPA_PRESETS, kappaOf, QUOTE_QUANTITIES } from '../lib/inner-seal/quote.js';
import { renderCarried } from '../lib/carried-evidence.js';

// E2 is the policy the worked values below were derived under; a case that names another preset says so.
const innerQuote = input => quoteUnder({ preset: 'E2', ...input });

// The quote's specified fixed fee and per-step C, written out here rather than read from the module so that the worked values below stand apart from it.
const FEE = 10000;
const C_PER_STEP = 200;

// An estimate of A as `estimateInnerA` answers it, its savings S the stock less the B and C estimates.
const estimateOf = ({ n, lA, bEst = 0 }) => {
  const cEst = C_PER_STEP * n;
  return { n, lA, bEst, cEst, sEst: lA - bEst - cEst };
};

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);

// kappa under the fixed fee K0 = 10000, the per-step C c = 200 and the five decimal alphas the quote is specified with (E2 19, W2 9.032, M2 2.456, S3 0.7706, X3 0.22), as an independent 90-digit Decimal evaluation of the stable-H expression of the frozen research record (`docs/research/2026-11-16-inner-compaction-kappa-presets.md`), evaluated apart from the module with the same literals: [preset, rho, n, kappa]. Rho 1 and 12.5 lie below the price anchor, where the compensation is negative and kappa falls under 1.
const KAPPA_ORACLE = [
  ['E2', 1, 8, '0.69143056299304489176'],
  ['E2', 10, 1, '0.99271714269042512192'],
  ['E2', 10, 8, '0.91647486099683858716'],
  ['E2', 10, 24, '2.1593491024123359955'],
  ['E2', 12.5, 8, '0.95194940469828341259'],
  ['E2', 25, 1, '1.0001344798720000000'],
  ['E2', 25, 8, '1.0688536944640000000'],
  ['E2', 25, 24, '2.8590497505280000000'],
  ['E2', 30, 8, '1.0994084552089021241'],
  ['E2', 40, 0, '1.0000000000000000000'],
  ['E2', 40, 1, '1.0040137549300154123'],
  ['E2', 40, 8, '1.1456008175730845496'],
  ['E2', 40, 24, '3.1426598644506811452'],
  ['E2', 80, 1, '1.0088321331129168471'],
  ['E2', 80, 8, '1.2397120157221604947'],
  ['E2', 80, 24, '3.4609829631855081995'],
  ['W2', 10, 1, '0.99928933081330597842'],
  ['W2', 10, 8, '0.96053235214758966126'],
  ['W2', 10, 24, '1.0496317276851174525'],
  ['W2', 25, 1, '1.0000012274077007872'],
  ['W2', 25, 8, '1.0050274619424243712'],
  ['W2', 25, 24, '1.4072244173363740672'],
  ['W2', 40, 0, '1.0000000000000000000'],
  ['W2', 40, 1, '1.0003740578721676542'],
  ['W2', 40, 8, '1.0280569134792198917'],
  ['W2', 40, 24, '1.5720565041485300963'],
  ['W2', 80, 1, '1.0008373518475554619'],
  ['W2', 80, 8, '1.0565559419327784368'],
  ['W2', 80, 24, '1.7671686203281316140'],
  ['M2', 10, 1, '0.99962903767058009306'],
  ['M2', 10, 8, '0.97790151531168075365'],
  ['M2', 10, 24, '0.91612001238625642272'],
  ['M2', 25, 1, '1.0000003337592242176'],
  ['M2', 25, 8, '1.0013670777823952896'],
  ['M2', 25, 24, '1.1107333003740184576'],
  ['M2', 40, 0, '1.0000000000000000000'],
  ['M2', 40, 1, '1.0001948037634427846'],
  ['M2', 40, 8, '1.0135831015963211290'],
  ['M2', 40, 24, '1.2065612296095700643'],
  ['M2', 80, 1, '1.0004364672521705136'],
  ['M2', 80, 8, '1.0287315230410063379'],
  ['M2', 80, 24, '1.3230031728365234646'],
  ['S3', 10, 1, '0.99997117799555576837'],
  ['S3', 10, 8, '0.99485980607992242199'],
  ['S3', 10, 24, '0.93720978534665602770'],
  ['S3', 25, 1, '1.0000000020106438425'],
  ['S3', 25, 8, '1.0000658847774299191'],
  ['S3', 25, 24, '1.0160100009154703346'],
  ['S3', 40, 0, '1.0000000000000000000'],
  ['S3', 40, 1, '1.0000151001758542853'],
  ['S3', 40, 8, '1.0027886707363865531'],
  ['S3', 40, 24, '1.0562638466952379954'],
  ['S3', 80, 1, '1.0000338628857603341'],
  ['S3', 80, 8, '1.0061704097914336352'],
  ['S3', 80, 24, '1.1058221437942334899'],
  ['X3', 10, 1, '0.99998459939972005103'],
  ['X3', 10, 8, '0.99723422959454979018'],
  ['X3', 10, 24, '0.96187856145189563066'],
  ['X3', 25, 1, '1.0000000005740223791'],
  ['X3', 25, 8, '1.0000188095653186896'],
  ['X3', 25, 24, '1.0045707243724415697'],
  ['X3', 40, 0, '1.0000000000000000000'],
  ['X3', 40, 1, '1.0000080678191406062'],
  ['X3', 40, 8, '1.0014761978257114051'],
  ['X3', 40, 24, '1.0266413826126684601'],
  ['X3', 80, 1, '1.0000180931167579278'],
  ['X3', 80, 8, '1.0032867737323413704'],
  ['X3', 80, 24, '1.0539359862100996929'],
];

// The first integer n from INNER_QUOTE.minSteps that passes under the E2 kappa, on the research record's paths G(n)=a*n, B(n)=k/20*G, T=0, C(n)=200n, B at most 300000, from the same independent evaluation with K0 = 10000: [rho, a, k, first n or null].
const FIRST_PASS_ORACLE = [
  [25, 500, 0, 13],
  [25, 500, 5, 15],
  [25, 500, 10, 19],
  [25, 500, 15, null],
  [25, 500, 19, null],
  [25, 5000, 0, 8],
  [25, 5000, 5, 9],
  [25, 5000, 10, 11],
  [25, 5000, 15, 16],
  [25, 5000, 19, 29],
  [25, 20000, 0, 8],
  [25, 20000, 5, 8],
  [25, 20000, 10, 10],
  [25, 20000, 15, 15],
  [25, 20000, 19, null],
  [40, 500, 0, 13],
  [40, 500, 5, 15],
  [40, 500, 10, 19],
  [40, 500, 15, null],
  [40, 500, 19, null],
  [40, 5000, 0, 8],
  [40, 5000, 5, 9],
  [40, 5000, 10, 12],
  [40, 5000, 15, 16],
  [40, 5000, 19, 30],
  [40, 20000, 0, 8],
  [40, 20000, 5, 8],
  [40, 20000, 10, 11],
  [40, 20000, 15, 15],
  [40, 20000, 19, null],
  [50, 500, 0, 14],
  [50, 500, 5, 16],
  [50, 500, 10, 20],
  [50, 500, 15, null],
  [50, 500, 19, null],
  [50, 5000, 0, 8],
  [50, 5000, 5, 9],
  [50, 5000, 10, 12],
  [50, 5000, 15, 17],
  [50, 5000, 19, 31],
  [50, 20000, 0, 8],
  [50, 20000, 5, 8],
  [50, 20000, 10, 11],
  [50, 20000, 15, 16],
  [50, 20000, 19, null],
  [80, 500, 0, 14],
  [80, 500, 5, 16],
  [80, 500, 10, 20],
  [80, 500, 15, null],
  [80, 500, 19, null],
  [80, 5000, 0, 8],
  [80, 5000, 5, 10],
  [80, 5000, 10, 13],
  [80, 5000, 15, 18],
  [80, 5000, 19, 33],
  [80, 20000, 0, 8],
  [80, 20000, 5, 9],
  [80, 20000, 10, 13],
  [80, 20000, 15, 17],
  [80, 20000, 19, null],
];

test('kappa is the preset formula under the specified fee and per-step C, n = 0 is 1 and a ratio under the price anchor is the formula as it stands, for every preset', () => {
  assert.deepEqual(Object.keys(KAPPA_PRESETS), ['E2', 'W2', 'M2', 'S3', 'X3']);
  assert.deepEqual(Object.values(KAPPA_PRESETS).map(({ p }) => p), [3, 4, 4, 5, 5]);
  for (const [name, rho, n, expected] of KAPPA_ORACLE) {
    const kappa = kappaOf(n, rho, KAPPA_PRESETS[name]);
    assert.ok(Math.abs(kappa - Number(expected)) <= 1e-13 * Math.abs(Number(expected)), `${name} rho ${rho} n ${n}: ${kappa} is not ${expected}`);
  }
  assert.ok(kappaOf(8, 12.5, KAPPA_PRESETS.E2) < 1 && kappaOf(8, 1, KAPPA_PRESETS.E2) < 1, 'under the anchor kappa is not clamped');
  assert.equal(kappaOf(0, 80, KAPPA_PRESETS.W2), 1);
});

test('the alpha of every preset is the nearest double of its decimal literal', () => {
  // The IEEE-754 bit patterns Python\'s correctly rounded float() reads from the decimal literals 19, 9.032, 2.456, 0.7706 and 0.22.
  const bits = { E2: '4033000000000000', W2: '402210624dd2f1aa', M2: '4003a5e353f7ced9', S3: '3fe8a8c154c985f0', X3: '3fcc28f5c28f5c29' };
  for (const [name, hex] of Object.entries(bits)) {
    assert.equal(Buffer.from(new Float64Array([KAPPA_PRESETS[name].alpha]).buffer).reverse().toString('hex'), hex, name);
  }
});

// The same estimate under each preset the caller names: the decision is the named preset's own, so the most aggressive one passes a quote the more conservative ones decline, and the snapshot records the preset that decided. The expected kappas are the independent oracle at n 8 and ratio 40; the lA values put q between each pair of adjacent kappas.
const KAPPA_AT_8_40 = { E2: '1.1456008175730845496', W2: '1.0280569134792198917', M2: '1.0135831015963211290', S3: '1.0027886707363865531', X3: '1.0014761978257114051' };

test('the preset the caller names decides the quote: one estimate triggers under the policies whose kappa it is under and not under the more conservative ones, and the snapshot records the preset and its kappa', () => {
  const cases = [
    { lA: 20000, triggers: { E2: 'quote', W2: null, M2: null, S3: null, X3: null } },
    { lA: 34000, triggers: { E2: 'quote', W2: 'quote', M2: null, S3: null, X3: null } },
    { lA: 38000, triggers: { E2: 'quote', W2: 'quote', M2: 'quote', S3: null, X3: null } },
    { lA: 46000, triggers: { E2: 'quote', W2: 'quote', M2: 'quote', S3: 'quote', X3: null } },
    { lA: 48000, triggers: { E2: 'quote', W2: 'quote', M2: 'quote', S3: 'quote', X3: 'quote' } },
  ];
  for (const { lA, triggers } of cases) {
    for (const [preset, trigger] of Object.entries(triggers)) {
      const quote = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA }), cRatio: 40, preset });
      assert.equal(quote.preset, preset, `lA ${lA}`);
      assert.equal(quote.arm, 'left', `lA ${lA} ${preset}`);
      close(quote.kappa, Number(KAPPA_AT_8_40[preset]), `lA ${lA} ${preset} kappa`);
      assert.equal(quote.trigger, trigger, `lA ${lA} ${preset}`);
    }
  }
});

// lA at n 8, ratio 30 whose quote's q is exactly E2's kappa there.
const EQUAL_LA = 16297.405044203542;

const GREAT = n => estimateOf({ n, lA: 1_000_000 });
const E2_KAPPA = (n, rho) => kappaOf(n, rho, KAPPA_PRESETS.E2);

test('the quote\'s kappa is the named preset\'s own for this n and ratio, the snapshot keeps the one that decided, and the results keep their worked values', () => {
  const cases = [
    { why: 'left, inside the band', n: 8, lA: 17000, trigger: 'quote', arm: 'left', nRef: 19.480519480519481, N: 22.493506493506494, jRef: 27.980498370281383, q: 1.0898128435730160 },
    { why: 'left, B in the fee', n: 8, lA: 20000, bEst: 1000, trigger: 'quote', arm: 'left', nRef: 18.908045977011494, N: 21.574712643678161, jRef: 27.264582661001793, q: 1.0847300694604319 },
    { why: 'left, above kappa', n: 8, lA: 12400, trigger: null, arm: 'left', nRef: 27.777777777777778, N: 32.074074074074074, jRef: 34.110535996293492, q: 1.1748297968237318 },
    { why: 'right, q under kappa', n: 20, lA: 156000, trigger: 'quote', arm: 'right', nRef: 1.9736842105263158, N: 2.7368421052631579, jRef: 13.328775143487707, q: 1.7058463257497542 },
    { why: 'left, a continuous N just inside the kappa', n: 8, lA: 16400, trigger: 'quote', arm: 'left', nRef: 20.270270270270270, N: 23.405405405405405, jRef: 28.603716733815668, q: 1.0979484134059245 },
  ];
  for (const { why, n, lA, bEst, trigger, arm, nRef, N, jRef, q } of cases) {
    const estimate = estimateOf({ n, lA, bEst });
    const quote = innerQuote({ n, estimate, cRatio: 30 });
    assert.equal(quote.trigger, trigger, why);
    assert.equal(quote.arm, arm, why);
    close(quote.nRef, nRef, `${why} nRef`);
    close(quote.N, N, `${why} N`);
    close(quote.jRef, jRef, `${why} jRef`);
    close(quote.q, q, `${why} q`);
    assert.deepEqual(
      [quote.n, quote.lA, quote.bEst, quote.cEst, quote.sEst, quote.cRatio, quote.fee],
      [n, estimate.lA, estimate.bEst, estimate.cEst, estimate.sEst, 30, FEE],
      `${why}: the snapshot keeps its inputs and parameters`,
    );
    close(quote.kappa, E2_KAPPA(n, 30), `${why} kappa`);
  }
  // The kappa of a ratio and a step count read off the independent oracle.
  close(innerQuote({ n: 8, estimate: GREAT(8), cRatio: 30 }).kappa, 1.0994084552089021, 'kappa at n 8, ratio 30');
  assert.equal(Object.hasOwn(INNER_QUOTE, 'kappa'), false, 'no fixed kappa stands beside the preset');
  const snapshot = innerQuote({ n: 8, estimate: estimateInnerA({ n: 8, texts: [], bText: null, ctp: CTP }), cRatio: 30 });
  assert.equal(Object.hasOwn(snapshot, 'todoEst'), false, 'the state block is no priced term of the quote');
});

test('the snapshot records the preset its kappa was priced under: the id it was handed, one the table holds, kept whatever the quote found, and the kappa is that preset\'s own', () => {
  for (const preset of Object.keys(KAPPA_PRESETS)) {
    const priced = innerQuote({ n: 8, estimate: GREAT(8), cRatio: 30, preset });
    assert.equal(priced.preset, preset);
    assert.equal(priced.kappa, kappaOf(8, 30, KAPPA_PRESETS[preset]));
  }
  const found = [
    ['a ratio that could not be read', { n: 24, estimate: GREAT(24), cRatio: null }],
    ['an estimate that failed', { n: 24, estimate: null, cRatio: 30 }],
    ['savings that are not positive', { n: 24, estimate: estimateOf({ n: 24, lA: C_PER_STEP * 24 }), cRatio: 30 }],
    ['a left quote above kappa', { n: 8, estimate: estimateOf({ n: 8, lA: 7400 }), cRatio: 30 }],
  ];
  for (const [why, input] of found) assert.equal(innerQuote({ ...input, preset: 'S3' }).preset, 'S3', why);
});

test('the left arm passes only under kappa, whatever the retired fixed 1.1 said: a q between 1.1 and kappa passes, a q above kappa declines', () => {
  // At n 8 and ratio 40, lA 18000 gives a q between the fixed 1.1 (which would decline) and kappa, lA 16000 a q above kappa.
  const between = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 18000 }), cRatio: 40 });
  assert.ok(between.arm === 'left' && between.q > 1.1 && between.q < between.kappa);
  assert.equal(between.trigger, 'quote');
  const above = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 16000 }), cRatio: 40 });
  assert.ok(above.arm === 'left' && above.q > above.kappa);
  assert.equal(above.trigger, null);
});

test('q equal to kappa does not pass, a q a ulp under it does', () => {
  // Found by stepping lA through adjacent doubles around the boundary at n 8, ratio 30, where q lands on kappa's double itself; every operation on the path is one correctly rounded IEEE step.
  const equal = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: EQUAL_LA }), cRatio: 30 });
  assert.equal(equal.arm, 'left');
  assert.equal(equal.q, equal.kappa, 'the sample sits on the boundary');
  assert.equal(equal.trigger, null);
  const under = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: EQUAL_LA * (1 + 1e-12) }), cRatio: 30 });
  assert.ok(under.q < under.kappa);
  assert.equal(under.trigger, 'quote');
});

test('a valid right arm passes whatever q is against kappa, and its snapshot keeps the kappa it was priced under', () => {
  const quote = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 200_000 }), cRatio: 30 });
  assert.equal(quote.arm, 'right');
  assert.ok(quote.q >= quote.kappa, 'q at or above kappa');
  assert.equal(quote.trigger, 'quote');
  close(quote.kappa, E2_KAPPA(8, 30), 'kappa');
});

test('below a ratio of 25 kappa runs under 1: a left quote cannot pass, a valid right arm still does, and the snapshot keeps kappa as computed', () => {
  // Ratio 12.5, n 8: kappa is under 1, and the fixed fee puts nRef above 8 for a lA of 10200.
  const left = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 10200 }), cRatio: 12.5 });
  assert.equal(left.arm, 'left');
  assert.ok(left.kappa < 1 && left.q >= 1);
  assert.equal(left.trigger, null);
  close(left.kappa, 0.95194940469828341259, 'left kappa');
  const right = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 300_000 }), cRatio: 12.5 });
  assert.equal(right.arm, 'right');
  assert.equal(right.trigger, 'quote');
  close(right.kappa, 0.95194940469828341259, 'right kappa');
  assert.equal(innerQuote({ n: 8, estimate: GREAT(8), cRatio: 1 }).trigger, 'quote', 'a ratio of 1 prices kappa under 1 as well, and the right arm passes');
  // Where the step count has lifted kappa over 1 a left quote passes under the anchor as well: ratio 12.5, n 12.
  const lifted = innerQuote({ n: 12, estimate: estimateOf({ n: 12, lA: 9000 }), cRatio: 12.5 });
  assert.equal(lifted.arm, 'left');
  assert.ok(lifted.q < lifted.kappa && lifted.kappa > 1);
  assert.equal(lifted.trigger, 'quote');
});

test('the first step count that passes under E2 on the research paths: from the minimum on, left under kappa or right, the quote of each step read through the module', () => {
  assert.equal(FIRST_PASS_ORACLE.length, 60);
  for (const [rho, a, k, first] of FIRST_PASS_ORACLE) {
    let found = null;
    for (let n = 1; n * a * k / 20 <= 300_000 && n <= 5000; n += 1) {
      const lA = a * n;
      const quote = innerQuote({ n, estimate: estimateOf({ n, lA, bEst: a * n * k / 20 }), cRatio: rho });
      if (quote.trigger === 'quote') { found = n; break; }
    }
    assert.equal(found, first, `ratio ${rho}, a ${a}, k ${k}`);
  }
});

test('the bounds: below the minimum nothing triggers however good the quote, and no step count is attempted beyond it whatever the quote', () => {
  assert.equal(innerQuote({ n: INNER_QUOTE.minSteps - 1, estimate: GREAT(INNER_QUOTE.minSteps - 1), cRatio: 30 }).trigger, null, 'below the minimum');
  assert.equal(innerQuote({ n: INNER_QUOTE.minSteps, estimate: GREAT(INNER_QUOTE.minSteps), cRatio: 30 }).trigger, 'quote', 'at the minimum');
  assert.equal(Object.hasOwn(INNER_QUOTE, 'hardSteps'), false);

  // A left quote at or past the retired hard bound's step count is declined where q is not under kappa: at ratio 1 kappa is under 1, and savings of 100 leave q above it.
  for (const n of [24, 30]) {
    const declined = innerQuote({ n, estimate: estimateOf({ n, lA: C_PER_STEP * n + 100 }), cRatio: 1 });
    assert.equal(declined.arm, 'left');
    assert.ok(declined.q >= declined.kappa, `the quote alone declines at ${n}`);
    assert.equal(declined.trigger, null, `no mandatory attempt at ${n}`);
  }
});

test('a quote with no results never triggers, wherever the step count: a missing ratio, a failed estimate, savings not positive or a kappa not computable leave no result made up, no kappa where the ratio is missing and no value read as zero', () => {
  const unpriced = { nRef: null, N: null, jRef: null, q: null, arm: null };
  const cases = [
    { why: 'a ratio that could not be read', n: 24, estimate: GREAT(24), cRatio: null },
    { why: 'a ratio that is not finite', n: 24, estimate: GREAT(24), cRatio: Infinity },
    { why: 'an estimate that failed', n: 24, estimate: null, cRatio: 30 },
    { why: 'savings that are not positive', n: 24, estimate: estimateOf({ n: 24, lA: C_PER_STEP * 24 }), cRatio: 30 },
    { why: 'savings below zero', n: 40, estimate: estimateOf({ n: 40, lA: 100 }), cRatio: 30 },
    { why: 'a ratio whose kappa is not a number', n: 8, estimate: GREAT(8), cRatio: 0 },
  ];
  for (const { why, n, estimate, cRatio } of cases) {
    const quote = innerQuote({ n, estimate, cRatio });
    assert.equal(quote.trigger, null, why);
    assert.deepEqual({ nRef: quote.nRef, N: quote.N, jRef: quote.jRef, q: quote.q, arm: quote.arm }, unpriced, why);
  }
  const failed = innerQuote({ n: 24, estimate: null, cRatio: 30 });
  assert.deepEqual([failed.lA, failed.bEst, failed.cEst, failed.sEst], [null, null, null, null], 'a failed estimate leaves its quantities missing, not zero');
  close(failed.kappa, E2_KAPPA(24, 30), 'a ratio read prices its kappa wherever the estimate failed');
  const unread = innerQuote({ n: 24, estimate: GREAT(24), cRatio: null });
  assert.deepEqual([unread.cRatio, unread.kappa], [null, null], 'no ratio, no kappa, and no old value stands in');
  assert.equal(innerQuote({ n: 7, estimate: null, cRatio: null }).trigger, null);
});

// A calibrated pair as a model policy supplies it, chosen so each figure below is worked by hand: an ASCII character is half a token, a CJK character two.
const CTP = Object.freeze({ ascii: 2, cjk: 0.5, version: 1 });

test('the estimate of A: L_A is each request text priced on its own under the model policy\'s calibrated pair, B the rendered B text as handed with nothing added to it, and C is the per-step estimate', () => {
  // The request texts of two messages: a user message of 'abcd' and '中文', and an assistant message of 'ok' and a call of the tool 'read' with its arguments.
  const texts = ['abcd中文', 'okread{"p":"中"}'];
  const path = '/repo/src/held.js';
  const carried = {
    paths: [{ path, displayPath: path, totalLines: 3, state: 'readable', write: [[1, 'shown again'], [2, 'new 中文 line']], omit: [1] }],
    skills: [{ name: 'tdd', text: 'test first' }],
  };
  const bText = renderCarried(carried);
  const estimate = estimateInnerA({ n: 8, texts, bText, ctp: CTP });

  // The first text: four ASCII characters are 2, two CJK characters 4. The second: fourteen ASCII characters are 7, one CJK character 2.
  assert.equal(estimate.lA, 6 + 9);
  assert.ok(bText.includes('new 中文 line') && !bText.includes('shown again') && bText.includes('test first'), 'the rendered B leaves the omitted line out');
  // The text's two CJK characters are 4 tokens, every other character half of one: no blank-line opening, address block or role framing is in it.
  assert.equal(estimate.bEst, (bText.length - 2) / 2 + 4);
  assert.equal(estimate.cEst, C_PER_STEP * 8);
  assert.equal(estimate.sEst, estimate.lA - estimate.bEst - C_PER_STEP * 8);
  assert.equal(estimate.n, 8);

  const none = estimateInnerA({ n: 8, texts, bText: null, ctp: CTP });
  assert.equal(none.bEst, 0, 'a carrier that changes no evidence renders no B');
  assert.equal(none.lA, 15);
  const unsaid = { paths: [{ path, displayPath: path, withdraw: [1, 2] }, { path: '/repo/src/back.js', displayPath: '/repo/src/back.js', state: 'readable' }], removed: ['/repo/src/gone.js'] };
  assert.equal(renderCarried(unsaid), null, 'withdrawn lines, a removed path and a readable state are no part of B');
  assert.equal(estimateInnerA({ n: 8, texts: [], bText: renderCarried(unsaid), ctp: CTP }).bEst, 0);
  assert.equal(estimateInnerA({ n: 8, texts: [], bText: null, ctp: CTP }).lA, 0, 'a range of nodes deriving no message has no A');
});

test('L_A prices each text on its own: the sum of the texts\' token counts, not the count of the texts joined', () => {
  // Under three ASCII characters to a token, one character is 1/3 of a token and four are 4/3. Their sum is 1.6666666666666665 where the five characters priced as one text are 1.6666666666666667, so only per-text pricing equals the sum.
  const ctp = { ascii: 3, cjk: 0.5, version: 1 };
  assert.notEqual(1 / 3 + 4 / 3, 5 / 3, 'the fixture tells the sum of per-text counts from the joined text\'s');
  assert.equal(estimateInnerA({ n: 8, texts: ['a', 'bcde'], bText: null, ctp }).lA, 1 / 3 + 4 / 3);
  assert.equal(estimateInnerA({ n: 8, texts: ['a', '', 'bcde'], bText: null, ctp }).lA, 1 / 3 + 0 + 4 / 3, 'a message with no text is no tokens');
});

test('C is priced per counted step and the fixed fee is the specified one: the estimate of n steps carries 200n as C, never a fixed total, and the quote is priced under a fee of 10000', () => {
  const estimateAt = n => estimateInnerA({ n, texts: ['abcd'], bText: null, ctp: CTP });
  assert.deepEqual([8, 24, 1].map(n => estimateAt(n).cEst), [1600, 4800, 200]);
  assert.equal(estimateAt(24).sEst, 2 - 4800);
  assert.equal(innerQuote({ n: 8, estimate: GREAT(8), cRatio: 30 }).fee, 10000);
  // The fixed load is the fee at write price: with no B, nRef = ratio * fee / S, 30 * 10000 / 998400.
  close(innerQuote({ n: 8, estimate: GREAT(8), cRatio: 30 }).nRef, 300000 / 998400, 'nRef under the fee');
});

// The summary call reads the active history once: its estimate is already at the cache-read price, so it adds to the fixed load as it stands. At n 8, ratio 25, E2 (kappa 1.068853694464, no price compensation at the anchor), no B and a range of lA 32850 (C 1600, S 31250), F is 250000 plus the read: [read, nRef, N, jRef, q, arm, trigger], worked apart from the module.
const READ_COST_AT_ANCHOR = [
  [0, 8, 9.2288, 17.2288, 1, 'right', 'quote'],
  [140625, 12.5, 13.7288, 21.2288, 1.0235529092553512, 'left', 'quote'],
  [312500, 18, 19.2288, 25.2288, 1.0792744799594115, 'left', null],
];

test('the summary call\'s one read of the history joins the fixed load once and not again at the price ratio: both arms use that one reference, the left arm still passes strictly under the same kappa, and the snapshot keeps the read it used', () => {
  const estimate = estimateOf({ n: 8, lA: 32850 });
  assert.equal(estimate.sEst, 31250);
  for (const [summaryReadCost, nRef, N, jRef, q, arm, trigger] of READ_COST_AT_ANCHOR) {
    const quote = innerQuote({ n: 8, estimate, cRatio: 25, summaryReadCost });
    const why = `read ${summaryReadCost}`;
    close(quote.nRef, nRef, `${why} nRef`);
    close(quote.N, N, `${why} N`);
    close(quote.jRef, jRef, `${why} jRef`);
    close(quote.q, q, `${why} q`);
    assert.deepEqual([quote.arm, quote.trigger], [arm, trigger], why);
    assert.equal(quote.summaryReadCost, summaryReadCost, `${why}: the snapshot keeps the read it was priced with`);
    assert.deepEqual([quote.fee, quote.sEst, quote.cEst, quote.bEst], [FEE, 31250, 1600, 0], `${why}: the fee, the savings and the B and C estimates stay as estimated`);
    close(quote.kappa, 1.068853694464, `${why} kappa is the one the read does not move`);
  }
});

test('a read that cannot be used leaves the quote as it was with no read recorded, and a read of zero is a valid one that is kept: missing, not a finite number or negative falls back whole', () => {
  const estimate = estimateOf({ n: 8, lA: 32850 });
  const original = innerQuote({ n: 8, estimate, cRatio: 25 });
  assert.equal(Object.hasOwn(original, 'summaryReadCost'), false, 'a quote priced with no read has none');
  for (const [why, summaryReadCost] of [['undefined', undefined], ['null', null], ['NaN', NaN], ['Infinity', Infinity], ['negative', -1], ['a text', '140625']]) {
    assert.deepEqual(innerQuote({ n: 8, estimate, cRatio: 25, summaryReadCost }), original, why);
  }
  const zero = innerQuote({ n: 8, estimate, cRatio: 25, summaryReadCost: 0 });
  assert.deepEqual({ ...zero, summaryReadCost: undefined }, { ...original, summaryReadCost: undefined });
  assert.equal(zero.summaryReadCost, 0, 'zero is a reading, kept');
  // A quote that has no results used no read, so records none.
  assert.equal(Object.hasOwn(innerQuote({ n: 8, estimate: null, cRatio: 25, summaryReadCost: 1 }), 'summaryReadCost'), false);
  assert.equal(Object.hasOwn(innerQuote({ n: 8, estimate, cRatio: null, summaryReadCost: 1 }), 'summaryReadCost'), false);
});

// ── The snapshot as a record keeps it ────────────────────────────────────────────────────────────────

test('a snapshot the quote answers reads as a quote after the log\'s JSON, one whose quantities are null as recorded does too, and every quantity the table names is a member of the snapshot', () => {
  const triggered = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 200_000 }), cRatio: 30 });
  assert.equal(triggered.trigger, 'quote');
  assert.equal(isQuote(triggered), true);
  assert.equal(isQuote(JSON.parse(JSON.stringify(triggered))), true);
  assert.deepEqual(QUOTE_QUANTITIES.filter(key => !(key in triggered)), [], 'each named quantity is the snapshot\'s own');

  const withoutResults = { ...triggered, ...Object.fromEntries(QUOTE_QUANTITIES.map(key => [key, null])), arm: null };
  assert.equal(isQuote(withoutResults), true, 'a quantity the quote has none of is null, as recorded');
  assert.equal(isQuote({ ...triggered, missing: null }), true, 'a member of an earlier snapshot beyond these is not read');
});

test('a value that is no snapshot of a triggered quote reads as none: a trigger other than quote, a quantity or a member that is no number, an arm outside the three, a count of steps that is no count', () => {
  const good = innerQuote({ n: 8, estimate: estimateOf({ n: 8, lA: 200_000 }), cRatio: 30 });
  const none = {
    'no value': undefined,
    'null': null,
    'text': 'quote',
    'a list': [good],
    'a declined quote': { ...good, trigger: null },
    'the retired hard trigger': { ...good, trigger: 'hard' },
    'a step count below zero': { ...good, n: -1 },
    'a fractional step count': { ...good, n: 1.5 },
    'a fee that is no number': { ...good, fee: null },
    'a kappa that is no number': { ...good, kappa: null },
    'a kappa that is not finite': { ...good, kappa: NaN },
    'an arm outside the three': { ...good, arm: 'middle' },
    ...Object.fromEntries(QUOTE_QUANTITIES.map(key => [`${key} that is text`, { ...good, [key]: '1' }])),
  };
  for (const [why, value] of Object.entries(none)) assert.equal(isQuote(value), false, why);
});
