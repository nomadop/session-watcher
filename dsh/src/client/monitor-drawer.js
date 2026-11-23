// dsh/src/client/monitor-drawer.js — the inner compaction monitor's drawer contents: the eight pages of a call's detail, the pages of a slot's detail, a handoff's pages and one of its turns, settlement reports, and notices for a detail not yet answered.
// The call, slot and handoff pages show the payloads of the host's `inner-monitor/call`, `inner-monitor/slots`, `inner-monitor/slot` and `inner-monitor/handoff` endpoints as they are, whole: text and JSON are set in `<pre>` through React, which escapes them, so nothing is parsed as Markdown, redacted or run, and a tool call is data to show.
import React from 'react';
import { elapsedOf, formatElapsed, slotTitleOf, contextChangeText, tokensOf, NOT_AVAILABLE, TOKEN_UNIT } from './monitor-state.js';
import { shownStatusOf } from '../../../public/lib/compactionEconomics.js';
import { blockListParts, quoteFactsOf, slotFactsOf, jsonText, stringOf } from './monitor-model.js';
import { CarriedFiles, ReadFiles } from './monitor-files.js';
import { PaybackPage, PaybackReport } from './monitor-settlement.js';
import { paybackPageOf } from './monitor-settlement-model.js';
import { ContextPage, ContextReport } from './monitor-context.js';
import { contextModelOf } from './monitor-context-model.js';
import { settlementViewOf } from './monitor-recall-model.js';
import { Notice, useResult } from './monitor-handle.js';

const h = React.createElement;

/** The endpoint the list of the slots of a committed attempt is read from, by the list of rows and by the summaries page alike. */
export const SLOTS_ENDPOINT = 'inner-monitor/slots';

// An id the detail lacks, a field an old record never had and a value the producer left out all read as this text.
function Missing({ t }) {
  return h('span', { className: 'sw-mon-missing' }, t('monitor.notRecorded'));
}

// A list of facts as a definition list: each entry is its term and its description, a node.
function Facts({ entries }) {
  return h('dl', { className: 'sw-mon-facts' }, entries.map(([term, description], at) => h(React.Fragment, { key: at }, h('dt', null, term), h('dd', null, description))));
}

// A text or a JSON value set whole in a preformatted block.
const Pre = ({ children }) => h('pre', { className: 'sw-mon-pre' }, children);
const Json = ({ value }) => h(Pre, null, jsonText(value));

// A section of a page: a heading, where it has one, and its content; any attribute besides `name` is the section's own.
const Section = ({ name, title, children, ...attributes }) => h('section', { className: 'sw-mon-section', 'data-sw-section': name, ...attributes }, title === undefined ? null : h('h3', { className: 'sw-mon-heading' }, title), children);

// A whole text set in a preformatted block; an empty one is the neutral marker.
const WholeText = ({ text, t }) => (text === '' ? h('p', { className: 'sw-mon-empty', 'data-sw-empty': '' }, t('monitor.slot.empty')) : h(Pre, null, text));

// One block as `blockParts` describes it: its label, where it has one, its text or its JSON set whole in a preformatted block, and a tool result's inner blocks inside it. Nothing a block holds is parsed or run.
function Block({ part: { kind, label, text, json, error, children } }) {
  return h('div', { className: 'sw-mon-block', 'data-block': kind, 'data-error': error === true ? '' : undefined },
    label === undefined ? null : h('span', { className: 'sw-mon-label' }, label),
    text === undefined ? null : h(Pre, null, text),
    json === undefined ? null : h(Pre, null, json),
    children === undefined ? null : children.map((child, at) => h(Block, { key: at, part: child })));
}

// The blocks of a message or a response in order, each as it is: a text or reasoning block as its text, a tool call as its name and raw arguments, a tool result around its own blocks, an attachment as its reference, and any other block as its JSON.
function Blocks({ blocks, t }) {
  return h(React.Fragment, null, blockListParts(blocks, t).map((part, at) => h(Block, { key: at, part })));
}

// One message: its role and its content blocks.
function Message({ message, t }) {
  return h('div', { className: 'sw-mon-message' }, h('span', { className: 'sw-mon-label' }, message?.role ?? t('monitor.notRecorded')), Array.isArray(message?.content) ? h(Blocks, { blocks: message.content, t }) : h(Json, { value: message }));
}

// What the carrier cache did for the call's request, one line per serialization in the order they ran, as the call record kept it; a call nothing was recorded for was not observed.
function CarrierCache({ evidence, t }) {
  if (evidence === undefined || evidence === null) return t('monitor.carrierCache.unobserved');
  return h('ol', { className: 'sw-mon-cache', 'data-sw-carrier-cache': '' },
    evidence.results.map(({ result, reason }, at) => h('li', { key: at, 'data-result': result },
      result === 'skipped' ? t('monitor.carrierCache.skipped', { reason: t(`monitor.carrierCache.reason.${reason}`) }) : t(`monitor.carrierCache.${result}`))),
    evidence.omitted > 0 ? h('li', { key: 'omitted', className: 'sw-mon-note', 'data-result': 'omitted' }, t('monitor.carrierCache.omitted', { count: evidence.omitted })) : null);
}

const seqText = (seq, t) => (seq === null || seq === undefined ? h(Missing, { t }) : t('monitor.overview.seq', { seq }));

// The selection the attempt asked for, from the options the caller gave and never a default the adapter would add.
const selectionOf = request => request.options ?? {};

/**
 * The overview of a call: the attempt's status and, for a committed one, its payback progress, what the carrier cache did for its request (`CarrierCache`), which of its records exist, the count of slots its carrier committed (zero included, none without a carrier), the selection it asked for, the events it summarizes, how its stream finished and the reason its end record recorded.
 * `detail` is the `inner-monitor/call` payload, `payback` the `paybackOf` of all the attempts and handoffs: the attempt's progress is shown in percent, the neutral marker where it is not known, and it reads `paid` in place of its status once it reaches `PAID_BACK_PERCENT`.
 */
export function OverviewPage({ detail, payback = new Map(), t }) {
  const { row, ids, request } = detail;
  const status = shownStatusOf(row, payback);
  const progress = payback.get(row.id);
  const { provider, model, reasoningEffort } = selectionOf(request);
  const present = value => (value === undefined || value === null ? h(Missing, { t }) : value);
  const entries = [
    [t('monitor.overview.status'), h('span', { className: 'sw-mon-status', 'data-status': status }, t(`monitor.status.${status}`))],
    ...(row.status === 'committed' ? [[t('monitor.overview.payback'), Number.isFinite(progress) ? `${progress}%` : NOT_AVAILABLE]] : []),
    [t('monitor.overview.callState'), t(`monitor.callState.${row.call.state}`)],
    [t('monitor.overview.carrierCache'), h(CarrierCache, { evidence: row.call.carrierCache, t })],
    [t('monitor.overview.recordStart'), seqText(ids.start, t)],
    [t('monitor.overview.recordCall'), seqText(ids.call, t)],
    [t('monitor.overview.recordEnd'), seqText(ids.end, t)],
    [t('monitor.overview.recordCarrier'), seqText(ids.carrier, t)],
    ...(row.slots === null ? [] : [[t('monitor.overview.slots'), row.slots]]),
    [t('monitor.overview.provider'), present(provider)],
    [t('monitor.overview.model'), present(model)],
    ...(reasoningEffort === undefined || reasoningEffort === null ? [] : [[t('monitor.overview.effort'), reasoningEffort]]),
    [t('monitor.overview.range'), t('monitor.overview.rangeValue', { first: row.range.first, last: row.range.last, count: row.range.count })],
    [t('monitor.overview.finish'), present(row.call.finish)],
    ...(row.reason === null ? [] : [[t('monitor.overview.endReason'), h(Pre, null, row.reason)]]),
    ...(row.call.thrown === null ? [] : [[t('monitor.overview.thrown'), h(Pre, null, row.call.thrown)]]),
  ];
  return h(Facts, { entries });
}

// The tools a request sent: their count and, folded, their definitions, else the reason there are none to show.
function ToolsSection({ tools, t }) {
  return h(Section, { name: 'tools', title: t('monitor.request.tools', { count: tools.count }) },
    Array.isArray(tools.definitions)
      ? h('details', { className: 'sw-mon-fold' }, h('summary', null, t('monitor.request.definitions')), h(Json, { value: tools.definitions }))
      : h('p', { className: 'sw-mon-note' }, tools.reason));
}

/**
 * What the call was asked, as the caller built it: the options, the count of earlier messages (their bodies are not shown) and the C tail whole, the sequence numbers, the tools sent and the tool history updated.
 */
export function RequestPage({ detail, t }) {
  const { request } = detail;
  const options = Object.entries(selectionOf(request)).map(([name, value]) => [name, stringOf(value)]);
  const updates = request.toolHistory?.updates;
  return h(React.Fragment, null,
    h(Section, { name: 'options', title: t('monitor.request.options') }, h(Facts, { entries: options })),
    h(Section, { name: 'messages', title: t('monitor.request.tail') },
      h('p', { className: 'sw-mon-note' }, t('monitor.request.messages', { count: request.messages.count })),
      h(Message, { message: request.messages.tail, t })),
    h(Section, { name: 'sequence', title: t('monitor.request.sequence') }, h(Facts, { entries: [[t('monitor.request.throughSeq'), request.throughSeq ?? h(Missing, { t })], [t('monitor.request.headerSeq'), request.headerSeq ?? h(Missing, { t })]] })),
    request.tools === undefined ? null : h(ToolsSection, { tools: request.tools, t }),
    updates === undefined ? null : h(Section, { name: 'toolHistory', title: t('monitor.request.toolHistory') },
      h(Facts, { entries: updates.map(({ messageId, additions }) => [messageId, additions.join(', ')]) })));
}

/**
 * What the call answered, the outcome the attempt recorded first: an end record's reason, whose cause a cancelled attempt names without claiming it caused anything, and the error the call threw.
 * The stream's compact records stay beside the assembled blocks because the blocks can leave out a tool call a truncated response carried; a tool call is shown, never run, and the text is never read as slots.
 */
export function ResponsePage({ detail, t }) {
  const { row, response } = detail;
  const outcome = [
    ...(row.reason === null ? [] : [[t('monitor.overview.endReason'), h(Pre, null, row.reason)]]),
    ...(row.call.thrown === null ? [] : [[t('monitor.overview.thrown'), h(Pre, null, row.call.thrown)]]),
  ];
  const outcomeSection = outcome.length === 0 ? null : h(Section, { name: 'outcome', title: t('monitor.response.outcome') }, h(Facts, { entries: outcome }));
  const body = response === null ? h('p', { className: 'sw-mon-note' }, t('monitor.response.none')) : h(React.Fragment, null,
    h(Section, { name: 'assembled', title: t('monitor.response.assembled') },
      response.blocks === null
        ? h('p', { className: 'sw-mon-note' }, t('monitor.response.assembleError', { message: response.error }))
        : response.blocks.length === 0 ? h('p', { className: 'sw-mon-note' }, t('monitor.response.noBlocks')) : h(Blocks, { blocks: response.blocks, t })),
    h(Section, { name: 'finish', title: t('monitor.response.finish') }, response.finish === null ? h(Missing, { t }) : h(Json, { value: response.finish })),
    h(Section, { name: 'raw', title: t('monitor.response.rawTitle') },
      h('details', { className: 'sw-mon-fold' }, h('summary', null, t('monitor.response.raw', { count: response.stream.length })), h(Json, { value: response.stream }))));
  return h(React.Fragment, null,
    outcomeSection,
    body);
}
/**
 * The usage of the call: the four numbers the reducer folds for display and, apart, the usage chunk as streamed.
 * Either reads not recorded where the call has none; the chunk is data, and no native usage field is read here.
 * Between them stands the context the seal moved, the row's `contextChange` before and after the compaction and the change in words, each a dash where it is missing or the host sent none.
 */
export function UsagePage({ detail, t }) {
  const usage = detail.usage;
  const { folded, raw } = usage ?? {};
  const change = detail.row?.contextChange;
  return h(React.Fragment, null,
    h(Section, { name: 'folded', title: t('monitor.usage.folded') }, folded === undefined || folded === null ? h(Missing, { t }) : h(Facts, { entries: [
      [t('monitor.usage.input'), tokensOf(folded.input)], [t('monitor.usage.output'), tokensOf(folded.output)], [t('monitor.usage.cacheRead'), tokensOf(folded.cacheRead)], [t('monitor.usage.cacheWrite'), tokensOf(folded.cacheWrite)],
    ] })),
    h(Section, { name: 'context', title: t('monitor.usage.context') }, h(Facts, { entries: [
      [t('monitor.context.before'), tokensOf(change?.before)], [t('monitor.context.after'), tokensOf(change?.after)], [t('monitor.context.change'), contextChangeText(change, t, TOKEN_UNIT)],
      [t('monitor.context.miss'), tokensOf(change?.miss)],
    ] })),
    h(Section, { name: 'raw', title: t('monitor.usage.raw') }, raw === undefined || raw === null ? h(Missing, { t }) : h(Json, { value: raw })));
}

// A time of the log as ISO text in UTC; a value no date can show is shown as it is.
function timeText(ms, t) {
  if (ms === null || ms === undefined) return h(Missing, { t });
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

/**
 * The times of the attempt and of its call, each its start, end and span apart, a running span read from `now`.
 * The time of the response's first chunk is listed on its own, as observed.
 */
export function TimingPage({ detail, now, t }) {
  const { row, timing, response } = detail;
  const span = part => {
    const ms = elapsedOf(row, part, now);
    return ms === null ? h(Missing, { t }) : formatElapsed(ms);
  };
  return h(Facts, { entries: [
    [t('monitor.timing.attemptStart'), timeText(timing.attempt.startedAt, t)],
    [t('monitor.timing.attemptEnd'), timeText(timing.attempt.endedAt, t)],
    [t('monitor.timing.attemptElapsed'), span('attempt')],
    [t('monitor.timing.callStart'), timeText(timing.call.startedAt, t)],
    [t('monitor.timing.callEnd'), timeText(timing.call.endedAt, t)],
    [t('monitor.timing.callElapsed'), span('call')],
    [t('monitor.timing.firstChunk'), timeText(response?.firstAt, t)],
  ] });
}

// One slot of the summaries page: its number among the carrier's slots, its title and its first seq, then its whole C string; an empty one is the neutral marker.
function SlotSummary({ slot, number, t }) {
  return h(Section, { title: t('monitor.summaries.heading', { number, title: slotTitleOf(slot, t), seq: slot.key }), 'data-sw-slot-summary': slot.key },
    h(WholeText, { text: slot.output, t }));
}

// The slots of a committed attempt, read through the same resource handle the list of its rows reads.
function SlotSummaries({ monitor, attemptId, t }) {
  const result = useResult(monitor.resource({ endpoint: SLOTS_ENDPOINT, attempt: attemptId }));
  return h(DetailBody, { result, t, render: ({ slots }) => h(React.Fragment, null, slots.map((slot, at) => h(SlotSummary, { key: slot.key, slot, number: at + 1, t }))) });
}

/**
 * The C strings of all the slots the attempt's carrier holds, in the carrier's order and whole: the list's one-line previews are cut by the list alone.
 * Only a committed attempt has a carrier, so any other says they come with the commit and subscribes to nothing.
 * `detail` is the `inner-monitor/call` payload, `monitor` the monitor's resource handles and `attemptId` the attempt they are read for.
 */
export function SummariesPage({ detail, monitor, attemptId, t }) {
  if (detail.row.status !== 'committed') return h(Notice, { state: 'summaries-pending' }, t('monitor.summaries.pending'));
  return h(SlotSummaries, { monitor, attemptId, t });
}

/**
 * The evidence the carrier changes beyond the carriers before it, the file text, removals and skills, as the host answers it in structure: a list of files, each folded to its path, the lines it writes and withdraws and its statistics, and the carrier's wording and B's whole text folded at its foot.
 * Only a committed attempt has a carrier; one whose carrier changed no evidence says so instead of showing an empty list.
 * `detail` is the `inner-monitor/call` payload.
 */
export function CarriedPage({ detail, t }) {
  if (detail.row.status !== 'committed') return h(Notice, { state: 'carried-pending' }, t('monitor.carried.pending'));
  if (detail.carried === null) return h(Notice, { state: 'carried-none' }, t('monitor.carried.none'));
  return h(CarriedFiles, { carried: detail.carried, t });
}

/**
 * The quote the attempt triggered on, as its attempt record keeps it: the estimate taken before the summary, which the carried page's committed B does not replace, and the compaction policy it was priced under; a value it holds none of reads as not recorded.
 * An attempt recorded without a quote says so; nothing is reconstructed for it.
 * `detail` is the `inner-monitor/call` payload.
 */
export function QuotePage({ detail, t }) {
  if (detail.quote === null || detail.quote === undefined) return h(Notice, { state: 'quote-none' }, t('monitor.quote.none'));
  return h(React.Fragment, null,
    h('p', { className: 'sw-mon-note' }, t('monitor.quote.note')),
    h(Facts, { entries: quoteFactsOf(detail.quote, t).map(([term, value]) => [term, value ?? h(Missing, { t })]) }));
}

// One source event of a slot: folded, opened where the call saw it as a surface node, with its structured blocks and, folded below, the event itself as recorded. The event a jump of the tools page names opens and takes the focus, which brings it into view.
function SourceEvent({ event, opened, t }) {
  const { seq, type, visible, blocks, raw } = event;
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (opened) ref.current.querySelector('summary').focus();
  }, [opened]);
  return h('details', { ref, className: 'sw-mon-event', 'data-sw-event': '', 'data-seq': seq, 'data-visible': String(visible), 'data-sw-opened': opened ? '' : undefined, open: visible || opened },
    h('summary', null,
      t('monitor.slot.event', { seq, type }),
      h('span', { className: 'sw-mon-tag', 'data-tag': visible ? 'surface' : 'earlier' }, t(visible ? 'monitor.slot.surface' : 'monitor.slot.earlier'))),
    blocks.length === 0 ? h('p', { className: 'sw-mon-note' }, t('monitor.slot.noBlocks')) : h(Blocks, { blocks, t }),
    h('details', { className: 'sw-mon-fold', 'data-sw-raw': '' },
      h('summary', null, t('monitor.slot.raw')),
      h(Json, { value: raw })));
}

/**
 * The overview of a slot: its number among the carrier's slots, its whole seqs, the turn and step it counted (nothing where it counted none), the category of its first event's source with that event's raw type and kind, and how many of its source events the call saw.
 * The source is the first event's alone and says nothing of the others; a detail without one reads as other content with its type and kind not recorded.
 * `detail` is the `inner-monitor/slot` payload.
 */
export function SlotOverviewPage({ detail, t }) {
  return h(Facts, { entries: slotFactsOf(detail, t).map(([term, value]) => [term, value ?? h(Missing, { t })]) });
}

/** The whole C string a slot was sealed to; an empty one is a neutral marker. `detail` is the `inner-monitor/slot` payload. */
export function SlotSummaryPage({ detail, t }) {
  return h(Section, { name: 'c' }, h(WholeText, { text: detail.c, t }));
}

/**
 * The events a slot summarizes as the recorded log has them.
 * `detail` is the `inner-monitor/slot` payload, whose events arrive already marked `visible` from the range the call recorded: a visible event is a surface node of the call, any other an earlier original source the call did not receive. The mark is shown as given and decides nothing about the C.
 * `opened` is `{ seq }` where the tools page jumped here: that event alone opens, comes into view and takes the focus; a seq the page holds no event for marks none.
 */
export function SlotSourcePage({ detail, opened = null, t }) {
  return h(Section, { name: 'sources', title: t('monitor.slot.sources') },
    detail.events.map(event => h(SourceEvent, { key: event.seq, event, opened: opened?.seq === event.seq, t })));
}

// One measured call of the usage page under the title naming its source: the four buckets as `callUsageOf` folds them, or the neutral marker for a call that recorded no usage as a whole.
// `marked` is the bucket the page sets apart in a colour of its own, by field and whatever its value; the mark wraps the number alone, which the shared `Facts` takes as any node.
function CallUsage({ name, title, usage, marked, t }) {
  const count = (field, value) => (marked === field ? h('span', { 'data-sw-usage': field }, tokensOf(value)) : tokensOf(value));
  return h(Section, { name, title }, usage === null || usage === undefined ? h(Missing, { t }) : h(Facts, { entries: [
    [t('monitor.slotUsage.input'), tokensOf(usage.input)], [t('monitor.usage.output'), count('output', usage.output)],
    [t('monitor.usage.cacheRead'), tokensOf(usage.cacheRead)], [t('monitor.usage.cacheWrite'), count('cacheWrite', usage.cacheWrite)],
  ] }));
}

/**
 * The measured usage of the slot's own call and of the call that came after it, and the estimate of the slot's original text, each from the `usage` of the `inner-monitor/slot` payload as it is.
 * The successor is a main call, or the summary call where the slot has no main call after it in its carrier; `null` where the host could not confirm it, which says so instead of reading as a missing call. A call that recorded no usage reads as not recorded, and the buckets are never zero-filled beyond the reducer's own.
 * The slot's own output and the successor's cache write are the two numbers the page colours (`data-sw-usage`), blue and amber: the output of the call that wrote the slot and the cache write of the call that paid for the context after it, each by its field, a zero too, and no state of the page (no threshold, no warning).
 * The estimate is the approximate count of the slot's original text as the compaction saw it, not the slot's summary, an attachment's content or a bill; a zero is a count, and one the carrier did not keep reads as not recorded. A slot with no measured call shows the estimate alone.
 */
export function SlotUsagePage({ detail, t }) {
  const { current, next, sourceTokens } = detail.usage;
  return h(React.Fragment, null,
    current === null ? null : h(CallUsage, { name: 'current', title: t('monitor.slotUsage.current', { seq: current.seq }), usage: current.usage, marked: 'output', t }),
    current === null ? null : next === null
      ? h(Section, { name: 'next', title: t('monitor.slotUsage.next') }, h('p', { className: 'sw-mon-note', 'data-sw-unconfirmed': '' }, t('monitor.slotUsage.unconfirmed')))
      : h(CallUsage, { name: 'next', title: t(next.kind === 'summary' ? 'monitor.slotUsage.nextSummary' : 'monitor.slotUsage.nextMain', { seq: next.seq }), usage: next.usage, marked: 'cacheWrite', t }),
    h(Section, { name: 'source', title: t('monitor.slotUsage.source') },
      h('p', { className: 'sw-mon-note' }, t('monitor.slotUsage.sourceNote')),
      sourceTokens === null ? h(Missing, { t }) : h('p', null, t('monitor.slotUsage.approx', { tokens: tokensOf(Math.round(sourceTokens)) }))));
}

// The words the tools page gives a warning kind, on a card and in its header alike. A direct read is told by the target its dispatch names, whatever the result answered, so it is worded as the attempt it was and never as a read that returned; every other kind is worded as the slot row words it.
const DIRECT_READS = ['handoff-recall', 'carrier-recall', 'verbatim-recall'];
const warningText = (kind, t) => t(DIRECT_READS.includes(kind) ? `monitor.tool.attempt.${kind}` : `monitor.warning.${kind}`);

// The words a warning wears on a card: a state kind as the short query or write, an old read with its share and counts, any other kind as `warningText` has it. The header words every kind by `warningText`.
function cardWarningText(warning, t) {
  switch (warning.kind) {
    case 'state-check':
    case 'state-mixed': return t('monitor.tool.stateQuery');
    case 'state-write': return t('monitor.tool.stateWrite');
    case 'old-attribution': {
      const { percent, over, oldLines, newLines } = warning;
      return t('monitor.tool.oldAttribution', { label: t('monitor.warning.old-attribution'), percent: percent === null ? NOT_AVAILABLE : `${over ? '>' : ''}${percent}%`, oldLines, newLines });
    }
    default: return warningText(warning.kind, t);
  }
}

// The blocks of a result event of the slot, the tool result's own and not the one block around them; none where the slot holds no such event.
const resultBlocksOf = (events, seq) => events.find(event => event.seq === seq)?.blocks.find(block => block.type === 'tool-result')?.blocks ?? [];

// The states a card shows while closed: an input nobody recorded, then the result's own: none recorded, an explicit failure, or empty. A call whose result is missing or empty is no failure, and a failure is only what the result says it is.
function toolStatesOf({ input, result }) {
  return [
    ...(input === null ? [['no-input', 'monitor.tool.noInput']] : []),
    ...(result === null ? [['no-result', 'monitor.tool.noResult']] : result.error ? [['error', 'monitor.tool.failed']] : result.empty ? [['empty-result', 'monitor.tool.emptyResult']] : []),
  ];
}

// One call of the slot: its name, the states and warnings it shows closed, the neutral note and jump of a result the pruner replaced, and its raw input and original output in two folded sections one above the other. Everything in it is data set through React: nothing is parsed or run.
function ToolCard({ card: { id, name, input, result, pruned, warnings }, events, open, t }) {
  return h('article', { className: 'sw-mon-tool', 'data-sw-tool': id },
    h('div', { className: 'sw-mon-tool-head' },
      h('span', { className: 'sw-mon-tool-name' }, name ?? t('monitor.notRecorded')),
      toolStatesOf({ input, result }).map(([state, key]) => h('span', { key: state, className: 'sw-mon-tool-state', 'data-state': state }, t(key)))),
    warnings.length === 0 ? null : h('ul', { className: 'sw-mon-tool-warnings' },
      warnings.map(warning => h('li', { key: warning.kind, className: 'sw-mon-tool-warning', 'data-sw-warning': warning.kind, 'data-sw-attention': '' }, cardWarningText(warning, t)))),
    pruned === null ? null : h('p', { className: 'sw-mon-tool-pruned', 'data-sw-pruned': '' },
      t('monitor.tool.pruned'), ' ',
      h('button', { type: 'button', className: 'sw-mon-link', 'data-sw-open-source': pruned.seq, onClick: () => { open?.(pruned.seq); } }, t('monitor.tool.openPruned', { seq: pruned.seq }))),
    input === null ? null : h('details', { className: 'sw-mon-fold', 'data-sw-tool-section': 'input' }, h('summary', null, t('monitor.tool.input')), h(WholeText, { text: input, t })),
    result === null || result.empty ? null : h('details', { className: 'sw-mon-fold', 'data-sw-tool-section': 'output' },
      h('summary', null, t('monitor.tool.output')), h(Blocks, { blocks: resultBlocksOf(events, result.seq), t })));
}

/**
 * The tool calls of a slot: the warnings the slot's cards do not hold, each kind once in the words of `warningText`, beside the note that "old" means attributed before the step wherever an old-attribution warning is shown, then one card per call in the order the assistant issued them (`ToolCard`).
 * `detail` is the `inner-monitor/slot` payload, whose `tools` the host builds and whose `events` hold each result's blocks; `open(seq)` is the jump to the source page's event at `seq`.
 */
export function SlotToolsPage({ detail, open, t }) {
  const { warnings, calls } = detail.tools;
  const explains = warnings.includes('old-attribution') || calls.some(card => card.warnings.some(({ kind }) => kind === 'old-attribution'));
  return h(React.Fragment, null,
    warnings.length === 0 && !explains ? null : h(Section, { name: 'warnings' },
      warnings.length === 0 ? null : h('ul', { className: 'sw-mon-tool-warnings' },
        warnings.map(kind => h('li', { key: kind, className: 'sw-mon-tool-warning', 'data-sw-warning': kind, 'data-sw-attention': '' }, warningText(kind, t)))),
      explains ? h('p', { className: 'sw-mon-note', 'data-sw-old-note': '' }, t('monitor.tool.oldNote')) : null),
    calls.map((card, at) => h(ToolCard, { key: at, card, events: detail.events, open, t })));
}

/**
 * The overview of a handoff: its type and token, when it was prepared and when it was delivered, the seq of its payload, the files read of those it kept and the skills it kept, and the context before and after it, each a dash where the row has none (a load has no context to compare). The type's value carries `data-type`, which the style colours by, as the list's type slot does.
 * `detail` is the `inner-monitor/handoff` payload.
 */
export function HandoffOverviewPage({ detail, t }) {
  const { row } = detail;
  const present = value => (value === undefined || value === null ? h(Missing, { t }) : value);
  return h(Facts, { entries: [
    [t('monitor.handoff.overview.type'), h('span', { 'data-type': row.type }, t(`monitor.handoff.type.${row.type}`))],
    [t('monitor.handoff.overview.token'), row.token],
    [t('monitor.handoff.overview.createdAt'), timeText(row.createdAt, t)],
    [t('monitor.handoff.overview.deliveredAt'), timeText(row.time, t)],
    [t('monitor.handoff.overview.seq'), seqText(row.id, t)],
    [t('monitor.handoff.overview.filesRead'), present(row.read)],
    [t('monitor.handoff.overview.filesKept'), present(row.kept)],
    [t('monitor.handoff.overview.skills'), row.skills],
    [t('monitor.handoff.overview.before'), tokensOf(row.contextChange?.before)],
    [t('monitor.handoff.overview.after'), tokensOf(row.contextChange?.after)],
  ] });
}

/** The whole summary the handoff carried. `detail` is the `inner-monitor/handoff` payload. */
export function HandoffSummaryPage({ detail, t }) {
  return h(Section, { name: 'summary' }, h(WholeText, { text: detail.summary, t }));
}

/**
 * The files the load read, as a list of files each folded to its path, the lines the load shows of it and its statistics; a file the load recorded in a form with no lines is one line saying so.
 * `detail` is the `inner-monitor/handoff` payload.
 */
export function HandoffFilesPage({ detail, t }) {
  return detail.files.length === 0
    ? h('p', { className: 'sw-mon-note' }, t('monitor.handoff.files.none'))
    : h(ReadFiles, { files: detail.files, t });
}

/** The turn page the load gave the model, whole; a handoff that carries none reads as not recorded. `detail` is the `inner-monitor/handoff` payload. */
export function HandoffTurnsPage({ detail, t }) {
  return h(Section, { name: 'turns' }, detail.turnPage === null ? h(Missing, { t }) : h(Pre, null, detail.turnPage));
}

/** The members of the handoff's lineage by label with their headlines, an omitted stretch by its label alone. `detail` is the `inner-monitor/handoff` payload. */
export function HandoffLineagePage({ detail, t }) {
  if (detail.lineage === null) return h(Missing, { t });
  return h(Facts, { entries: detail.lineage.map(member => [member.label, member.omitted === true ? t('monitor.handoff.lineage.omitted') : member.headline]) });
}

/**
 * One turn of a handoff, whole and on one page: what the user said and the note. A turn with no note says so, and an empty note reads as any empty text.
 * `turn` is an element of the `turns` of the `inner-monitor/handoff` payload.
 */
export function TurnDetail({ turn, t }) {
  const { user, note } = turn;
  return h(React.Fragment, null,
    h(Section, { name: 'user', title: t('monitor.handoff.turn.user') }, h(WholeText, { text: user, t })),
    h(Section, { name: 'note', title: t('monitor.handoff.turn.note') },
      note === null ? h('p', { className: 'sw-mon-empty', 'data-sw-empty': '' }, t('monitor.handoff.turn.noNote')) : h(WholeText, { text: note, t })));
}

const CALL_PAGES = { overview: OverviewPage, request: RequestPage, response: ResponsePage, summaries: SummariesPage, carried: CarriedPage, quote: QuotePage, usage: UsagePage, timing: TimingPage };
const SLOT_PAGES = { overview: SlotOverviewPage, summary: SlotSummaryPage, source: SlotSourcePage };
const HANDOFF_PAGES = { overview: HandoffOverviewPage, summary: HandoffSummaryPage, files: HandoffFilesPage, turns: HandoffTurnsPage, lineage: HandoffLineagePage };
export const SETTLEMENT_PAGES = { payback: PaybackPage, context: ContextPage };

// The pages of a detail behind a tab strip, `first` shown to begin with and the page the component's own state: the drawer keys the component by the selected identity, so another item opens at its first page. A caller that moves the page itself gives `page` and `onPage`; a `page` the pages do not hold shows `first`.
export function PagedDetail({ pages, first, labels, page: given, onPage, ...props }) {
  const [own, setOwn] = React.useState(first);
  const page = pages[given ?? own] === undefined ? first : given ?? own;
  const select = onPage ?? setOwn;
  const Page = pages[page];
  return h(React.Fragment, null,
    h('div', { className: 'sw-mon-tabs', role: 'tablist' }, Object.keys(pages).map(name => h('button', {
      key: name, type: 'button', role: 'tab', className: 'sw-mon-tab', 'data-page': name, 'aria-selected': name === page, onClick: () => { select(name); },
    }, props.t(`${labels}.${name}`)))),
    h('div', { className: 'sw-mon-page', role: 'tabpanel', 'data-page': page }, h(Page, props)));
}

/** The eight pages of a call's detail behind a tab strip, the overview first. `detail` is the `inner-monitor/call` payload, `monitor` the monitor's resource handles and `attemptId` the attempt the detail is of, which the summaries page reads the slots of, `payback` the `paybackOf` of all the attempts and handoffs, which the overview reads, and `now` the display clock a running span reads. */
export function CallDetail({ detail, monitor, attemptId, payback, now, t }) {
  return h(PagedDetail, { pages: CALL_PAGES, first: 'overview', labels: 'monitor.page', detail, monitor, attemptId, payback, now, t });
}

// Whether a slot's tools are anything to show: a call, a result or a warning; an answer without the field, an older host's, has none.
const hasTools = ({ tools }) => tools !== undefined && (tools.calls.length > 0 || tools.warnings.length > 0);

// Whether a slot's usage is anything to show: a measured call or an estimate, a zero one included; an answer without the field, an older host's, has none.
const hasUsage = ({ usage }) => usage !== undefined && (usage.current !== null || usage.sourceTokens !== null);

/**
 * The pages of a slot's detail behind a tab strip, the summary first: the overview, the summary, the source text and, where the slot has a measured call or an estimate to show, the usage and, where it has tools to show, the tools. `detail` is the `inner-monitor/slot` payload.
 * The page is this component's state because a card's jump moves it: it opens the source page with `opened`, the event it names, which the next tab the reader chooses clears.
 */
export function SlotDetail({ detail, t }) {
  const [page, setPage] = React.useState('summary');
  const [opened, setOpened] = React.useState(null);
  const pages = { ...SLOT_PAGES, ...(hasUsage(detail) ? { usage: SlotUsagePage } : {}), ...(hasTools(detail) ? { tools: SlotToolsPage } : {}) };
  const select = (name) => { setOpened(null); setPage(name); };
  const open = (seq) => { setOpened({ seq }); setPage('source'); };
  return h(PagedDetail, { pages, first: 'summary', page, onPage: select, labels: 'monitor.slotPage', detail, opened, open, t });
}

/** The pages of a handoff's detail behind a tab strip, the overview first; the lineage page is a load's alone. `detail` is the `inner-monitor/handoff` payload. */
export function HandoffDetail({ detail, t }) {
  const pages = detail.row.type === 'load' ? HANDOFF_PAGES : Object.fromEntries(Object.entries(HANDOFF_PAGES).filter(([name]) => name !== 'lineage'));
  return h(PagedDetail, { pages, first: 'overview', labels: 'monitor.handoffPage', detail, t });
}

/**
 * The settlement of a segment a `/sw-continue` cleared behind a tab strip, the payback page first and the context page after it. A settlement the list no longer holds shows nothing.
 * `settlement` is an entry of `settlementsOf`, undefined where there is none, and `handoffId` the handoff that cleared the segment. Both pages read the same settlement resource; only the context page reads the amber line from the session store.
 */
export function SettlementDetail({ settlement, handoffId, monitor, session, t }) {
  return settlement === undefined ? null : h(PagedDetail, { pages: SETTLEMENT_PAGES, first: 'payback', labels: 'monitor.settlementPage', settlement, handoffId, monitor, session, t });
}

// The pages of the current segment's snapshot: the same pages of the same answer as a closed segment's, drawn from the view (`settlementViewOf`) of the answer the toolbar read once.
export const CURRENT_SETTLEMENT_PAGES = {
  payback: ({ view, t }) => h(PaybackReport, { model: paybackPageOf(view, t, true), t }),
  context: ({ view, monitor, t }) => h(ContextReport, { model: contextModelOf(view, null, t), current: true, monitor, t }),
};

/**
 * The current segment's settlement as the toolbar read it: an empty segment, a segment with no compaction priced yet and one priced in part say so; otherwise the two pages, the payback page first, over the one answer. `result` is `readCurrentSettlement`'s and `monitor` hands the reader of a target's text.
 */
export function CurrentSettlementDetail({ result, monitor, t }) {
  return h(DetailBody, { result, t, render: () => {
    const view = settlementViewOf(null, result);
    if (view.base.count === 0) return h(Notice, { state: 'current-empty' }, t('monitor.settlement.current.empty'));
    if (!view.priced) return h(Notice, { state: 'current-pending' }, t('monitor.settlement.recall.unpriced'));
    return h(React.Fragment, null,
      view.base.rows.some(row => row.saved === null) ? h(Notice, { state: 'current-partial' }, t('monitor.settlement.current.partial')) : null,
      h(PagedDetail, { pages: CURRENT_SETTLEMENT_PAGES, first: 'payback', labels: 'monitor.settlementPage', view, monitor, t }));
  } });
}

/**
 * What a detail's resource result shows: a text of its own for a read not yet answered, an unavailable one and an unreachable one, and for a ready one `render(value)`, the endpoint's whole payload.
 */
export function DetailBody({ result, t, render }) {
  if (result === null) return h(Notice, { state: 'detail-loading' }, t('monitor.detail.loading'));
  if (result.kind === 'unavailable') return h(Notice, { state: 'detail-unavailable' }, t('monitor.detail.unavailable'));
  if (result.kind === 'unreachable') return h(Notice, { state: 'detail-unreachable' }, t('monitor.detail.unreachable', { message: result.message }));
  return render(result.value);
}
