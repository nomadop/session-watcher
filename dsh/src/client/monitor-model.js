// dsh/src/client/monitor-model.js — the inner compaction monitor's display model: what a parent row's meta, a content block and a slot's overview say, as plain data with the texts already worded.
// The React pages and the Markdown export each render this one model, so the two never disagree on what a detail says. It imports the pure modules beside it and nothing else, so Node and the browser bundle load it alike.
import { NOT_AVAILABLE, PART_SEPARATOR, paybackPercent, elapsedOf, formatElapsed, handoffSegmentOf, contextChangeText, contextRangeText, contextMissText, sourceCategoryOf } from './monitor-state.js';
import { compactCount } from './monitor-files-model.js';

/** A value as indented JSON text; a value JSON has no text for is shown as `String` makes it. */
export const jsonText = value => JSON.stringify(value, null, 2) ?? String(value);

/** A value as it is when it is a text, else as indented JSON. */
export const stringOf = value => (typeof value === 'string' ? value : jsonText(value));

// The step slot: the count of the range the attempt summarizes, `stepN` being the quote's own n, so it is missing exactly where the quote is.
const stepPart = (attempt, t) => ({ part: 'step', text: Number.isFinite(attempt.stepN) ? t('monitor.meta.step', { count: attempt.stepN }) : NOT_AVAILABLE, title: t('monitor.meta.step.title') });

// The decimals a deviation and a tolerance read to in a row's meta.
const DECIMALS = 2;

// The estimate slot: the deviation q of the quote the attempt triggered on, a dash where the quote has none or the attempt was recorded without one; its title is the deviation's meaning, with the tolerance kappa the quote was compared with where it holds one.
function estimatePart({ trigger }, t) {
  const q = trigger?.q;
  const kappa = trigger?.kappa;
  return {
    part: 'estimate',
    text: Number.isFinite(q) ? t('monitor.meta.estimate', { q: q.toFixed(DECIMALS) }) : NOT_AVAILABLE,
    title: Number.isFinite(kappa) ? t('monitor.meta.estimate.kappa.title', { kappa: kappa.toFixed(DECIMALS) }) : t('monitor.meta.estimate.title'),
  };
}

/**
 * The parts of a parent row's meta in the order the row shows them, each `{ part, text, title?, attention? }`: its own `time`, the `step` count of the range it summarizes, the `estimate` deviation of the quote it triggered on, the `usage` of its call (the output alone; the input is the drawer's usage page alone), the `range` of the context before and after the seal and the `context` change in words, the cache `miss` of the next call (the tokens it rebuilt), and the attempt's own `seq`.
 * `text` is what the part reads and `title` the tooltip the row gives it, absent where the part has none; what the row has none of reads as `NOT_AVAILABLE`. `attention` marks the readings the row draws as a warning: a context that grew in the context slot and, where `missWarned` says the rebuild was unexpected (`unexpectedMissOf`), the cache rebuild slot; a reading filter, saying no status, failure or loss; both keep the text they have unmarked, their titles telling the reason. `attempt` is a row of `rowsOf`, `now` the display clock a running span reads.
 */
export function parentMetaParts(attempt, now, t, missWarned = false) {
  const elapsed = elapsedOf(attempt, 'attempt', now);
  const { usage } = attempt.call;
  const grew = attempt.contextChange?.delta > 0;
  return [
    { part: 'time', text: elapsed === null ? NOT_AVAILABLE : formatElapsed(elapsed), title: t('monitor.meta.time') },
    stepPart(attempt, t),
    estimatePart(attempt, t),
    usage === null
      ? { part: 'usage', text: NOT_AVAILABLE }
      : {
        part: 'usage',
        text: t('monitor.usage.cell', { output: usage.output }),
        title: t('monitor.usage.title', { output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }),
      },
    { part: 'range', text: contextRangeText(attempt.contextChange, t), title: t('monitor.meta.range.title') },
    grew
      ? { part: 'context', text: contextChangeText(attempt.contextChange, t), title: t('monitor.meta.context.grew'), attention: true }
      : { part: 'context', text: contextChangeText(attempt.contextChange, t), title: t('monitor.meta.context') },
    missWarned
      ? { part: 'miss', text: contextMissText(attempt.contextChange, t), title: t('monitor.meta.miss.unexpected'), attention: true }
      : { part: 'miss', text: contextMissText(attempt.contextChange, t), title: t('monitor.meta.miss.title') },
    { part: 'seq', text: t('monitor.overview.seq', { seq: attempt.id }) },
  ];
}

/** A handoff's title, by the segment its payload was delivered in; it has no ordinal and no status. `handoff` is a row of the host's `handoffs`. */
export const handoffTitle = (handoff, t) => t('monitor.object.handoff', { epoch: handoffSegmentOf(handoff) });

/**
 * The parts of a handoff row's meta in the order the row shows them, each `{ part, text, title?, type? }`: its `type` (load or continue) and its `token`, both as they are with no label, the `files` read of those kept, the `skills` kept, the `lineage` number, the `range` of the context before and after it, the `context` change in words, and the row's own `seq`. The type part alone carries `type`, the handoff's type for the row to colour.
 * The two slots of the context are the compaction's own texts over the row's `contextChange`, which a load row never has, so they read as dashes; what the row has none of reads as `NOT_AVAILABLE` in its slot.
 * `handoff` is a row of the host's `handoffs`.
 */
export function handoffMetaParts(handoff, t) {
  const { type, token, read, kept, skills, lineage, contextChange } = handoff;
  const known = (...values) => values.every(Number.isFinite);
  return [
    { part: 'type', text: t(`monitor.handoff.type.${type}`), title: t('monitor.handoff.meta.type.title'), type },
    { part: 'token', text: token, title: t('monitor.handoff.meta.token.title') },
    { part: 'files', text: known(read, kept) ? t('monitor.handoff.meta.files', { read, kept }) : NOT_AVAILABLE, title: t('monitor.handoff.meta.files.title') },
    { part: 'skills', text: t('monitor.handoff.meta.skills', { count: skills }), title: t('monitor.handoff.meta.skills.title') },
    { part: 'lineage', text: known(lineage) ? t('monitor.handoff.meta.lineage', { count: lineage }) : NOT_AVAILABLE, title: t('monitor.handoff.meta.lineage.title') },
    { part: 'range', text: contextRangeText(contextChange, t, 'monitor.handoff.meta.range'), title: t('monitor.handoff.meta.range.title') },
    { part: 'context', text: contextChangeText(contextChange, t), title: t('monitor.meta.context') },
    { part: 'seq', text: t('monitor.overview.seq', { seq: handoff.id }) },
  ];
}

// The sign of a loss, U+2212, which no hyphen stands for.
const MINUS = '\u2212';

// The figures of a settlement, or of one of its compactions, as the texts `format` makes of the whole numbers they round to: what it saved, what it cost, the difference of the two rounded figures with its sign, none at zero, and the share of the cost it saved as `paybackPercent` has it of the unrounded figures.
function settlementFigures(saved, cost, format) {
  const net = Math.round(saved) - Math.round(cost);
  return {
    saved: format(Math.round(saved)),
    cost: format(Math.round(cost)),
    net: `${net > 0 ? '+' : net < 0 ? MINUS : ''}${format(Math.abs(net))}`,
    payback: `${paybackPercent(saved, cost)}%`,
  };
}

/**
 * The parts of a settlement row's meta in the order the row shows them, each `{ part, text, title }`: the `count` of the committed compactions of the segment, the `steps` the segment ran, what the compactions `saved`, what they `cost`, the `net` of the two with its sign and the `payback`, the share of the cost saved. The saved, cost and net figures are compact counts of read-price tokens, rounded before they are subtracted; no part is marked as a warning, a loss being signed and no more.
 * `settlement` is an entry of `settlementsOf`.
 */
export function settlementMetaParts(settlement, t) {
  const figures = settlementFigures(settlement.saved, settlement.cost, compactCount);
  return [
    { part: 'count', text: t('monitor.settlement.count', { count: settlement.count }), title: t('monitor.settlement.count.title') },
    { part: 'steps', text: t('monitor.settlement.steps', { count: settlement.steps }), title: t('monitor.settlement.steps.title') },
    { part: 'saved', text: t('monitor.settlement.saved', { count: figures.saved }), title: t('monitor.settlement.saved.title') },
    { part: 'cost', text: t('monitor.settlement.cost', { count: figures.cost }), title: t('monitor.settlement.cost.title') },
    { part: 'net', text: t('monitor.settlement.net', { count: figures.net }), title: t('monitor.settlement.net.title') },
    { part: 'payback', text: t('monitor.settlement.payback', { percent: figures.payback }), title: t('monitor.settlement.payback.title') },
  ];
}

// The four figure texts of a line of a settlement's text, in the words of its parts.
const figureTexts = (figures, t) => [
  t('monitor.settlement.saved', { count: figures.saved }),
  t('monitor.settlement.cost', { count: figures.cost }),
  t('monitor.settlement.net', { count: figures.net }),
  t('monitor.settlement.payback', { percent: figures.payback }),
];

const NO_FIGURES = { saved: NOT_AVAILABLE, cost: NOT_AVAILABLE, net: NOT_AVAILABLE, payback: NOT_AVAILABLE };

/**
 * A settlement as the text of its drawer: a line for each compaction of its rows, titled as its own row is, with its figures as whole numbers and a dash for each of those it has none of; the total line, its `count`, its `steps` and the figures of the sums; and, on a line of its own, the unit the figures are in.
 * `settlement` is an entry of `settlementsOf`.
 */
export function settlementTextOf(settlement, t) {
  const { epoch, count, steps, saved, cost, rows } = settlement;
  return [
    ...rows.map(row => [
      t('monitor.object.attempt', { epoch, ordinal: row.ordinal }),
      ...figureTexts(row.saved === null ? NO_FIGURES : settlementFigures(row.saved, row.cost, String), t),
    ].join(PART_SEPARATOR)),
    [t('monitor.settlement.total'), t('monitor.settlement.count', { count }), t('monitor.settlement.steps', { count: steps }), ...figureTexts(settlementFigures(saved, cost, String), t)].join(PART_SEPARATOR),
    t('monitor.settlement.unit'),
  ].join('\n');
}

// A quantity of a quote as the page shows it: a whole number as it is, any other to three decimals, null where the quote has none.
const quantityText = value => (value === null || value === undefined ? null : Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3))));

// The quantities the page lists before the compaction policy and after it.
const QUANTITIES_BEFORE_PRESET = ['n', 'lA', 'bEst', 'cEst', 'sEst', 'cRatio', 'fee'];
const QUANTITIES_AFTER_PRESET = ['kappa', 'q'];

/** The ids of the tolerance presets a quote can be priced under, the names `monitor.quote.preset.<id>` words; the host's `KAPPA_PRESETS` holds the same ids, which a test keeps equal. */
export const KAPPA_PRESET_IDS = Object.freeze(['E2', 'W2', 'M2', 'S3', 'X3']);

/**
 * The facts of a quote as `[term, value]` in the order its page lists them: the reason it has no results where it has none, its inputs and parameters, the compaction policy it was priced under, its tolerance kappa, its result q and the arm, `value` a text, null where the quote holds none, a quote that lacks `preset` and a preset id the client has no name for included; the renderers word that themselves. The reference's own intermediates (`nRef`, `N`, `jRef`) stay in the snapshot and are not listed.
 * `quote` is the `innerQuote` snapshot the attempt record keeps.
 */
export function quoteFactsOf(quote, t) {
  const quantity = key => [t(`monitor.quote.${key}`), quantityText(quote[key])];
  return [
    ...(quote.missing === null ? [] : [[t('monitor.quote.missingReason'), t(`monitor.quote.missing.${quote.missing}`)]]),
    ...QUANTITIES_BEFORE_PRESET.map(quantity),
    [t('monitor.quote.preset'), KAPPA_PRESET_IDS.includes(quote.preset) ? t(`monitor.quote.preset.${quote.preset}`) : null],
    ...QUANTITIES_AFTER_PRESET.map(quantity),
    [t('monitor.quote.arm'), quote.arm === null ? null : t(`monitor.quote.arm.${quote.arm}`)],
  ];
}

/**
 * One content block of a message or a response as the drawer shows it: `{ kind, label?, text?, json?, error?, children? }`.
 * `kind` is `text`, `reasoning`, `tool-call`, `tool-result`, `image`, `file` or `unknown`, the last for a block of any other type and for a value that is no block. `label` is the words that name the block, `text` its body as a text (a tool call's body is its raw arguments, nothing parsed), `json` the indented JSON of what is shown as data (an attachment's reference, an unknown block). A tool result has `children`, the parts of its inner blocks, and `error: true` where it is an error; nothing a block holds is parsed or run.
 */
export function blockParts(block, t) {
  switch (block?.type) {
    case 'text':
      return { kind: 'text', text: stringOf(block.text) };
    case 'reasoning':
      return { kind: 'reasoning', label: t('monitor.block.reasoning'), text: stringOf(block.text) };
    case 'tool-call':
      return { kind: 'tool-call', label: t('monitor.block.toolCall', { name: block.name }), text: stringOf(block.arguments) };
    case 'tool-result':
      return {
        kind: 'tool-result',
        label: t(block.isError === true ? 'monitor.block.toolError' : 'monitor.block.toolResult', { id: stringOf(block.callId ?? '') }),
        ...(block.isError === true ? { error: true } : {}),
        children: blockListParts(block.blocks, t),
      };
    case 'image':
    case 'file':
      return { kind: block.type, label: t(`monitor.block.${block.type}`), json: jsonText(block.attachment) };
    case 'unknown':
      return { kind: 'unknown', label: t('monitor.block.unknown'), json: jsonText(block.raw) };
    default:
      return { kind: 'unknown', label: t('monitor.block.unknown'), json: jsonText(block) };
  }
}

/** The parts of a list of blocks in order, none where `blocks` is no list. */
export function blockListParts(blocks, t) {
  return (Array.isArray(blocks) ? blocks : []).map(block => blockParts(block, t));
}

/**
 * The facts of a slot's overview as `[term, value]` in the order the overview lists them: its number, its whole seqs, the turn and step it counted (nothing where it counted none), the category of its first event's source with that event's raw type and kind, and how many of its source events the call saw.
 * `value` is a text or a number, null where the detail records none; the renderers word that themselves. `detail` is the `inner-monitor/slot` payload.
 */
export function slotFactsOf(detail, t) {
  const { number, seqs, turn, step, source, events } = detail;
  return [
    [t('monitor.slot.number'), number],
    [t('monitor.slot.seqs'), seqs.join(', ')],
    ...(turn === null ? [] : [[t('monitor.slot.turn'), turn]]),
    ...(step === null ? [] : [[t('monitor.slot.step'), step]]),
    [t('monitor.slot.source'), t(`monitor.source.${sourceCategoryOf(source)}`)],
    [t('monitor.slot.sourceType'), source?.type ?? null],
    [t('monitor.slot.sourceKind'), source?.kind ?? null],
    [t('monitor.slot.visibleCount'), t('monitor.slot.visibleCountValue', { visible: events.filter(event => event.visible).length, total: events.length })],
  ];
}
