// test/helpers/source-inputs.js — fold inputs for the measurement source fold, written by hand in the canonical Observation shapes.
// What a harness adapter hands the fold per event is `{ seq, observations, diagnostics, sealed?, mainCall }`; here each builder gives one event's input without its seq, and `sourceLog` lays a list of them out in log order, the seq the index. A `sealed` entry given as a builder's result is resolved to the seq that result landed at.

/** A usage as the Observations carry it. */
export const usage = (cacheRead, { input = 2, output = 40, cacheWrite = 100 } = {}) => ({ input, output, cacheRead, cacheWrite });

const draft = (shape = {}) => ({ observations: [], diagnostics: [], mainCall: false, ...shape });

/** An event that yields no Observation. */
export const quiet = () => draft();

/** A turn's opening: a human question, a turn boundary and its text. */
export const question = () => draft({
  observations: [{ type: 'turn-boundary', provenance: 'human' }, { type: 'text', role: 'human', text: 'Q', provenance: 'human' }],
});

/** A main call: its text when it has one, one tool use per call id in `tools`, then its usage when it reports one. */
export const call = ({ tools = [], usage: reported = null, text = null } = {}) => draft({
  mainCall: true,
  observations: [
    ...(text === null ? [] : [{ type: 'text', role: 'assistant', text, provenance: 'assistant' }]),
    ...tools.map(toolUseId => ({ type: 'tool-use', toolUseId, name: 'read', input: {}, provenance: 'assistant' })),
    ...(reported === null ? [] : [{ type: 'usage', usage: reported, provenance: 'assistant' }]),
  ],
});

/** A main call that yields no Observation, which a message with a malformed usage does. */
export const callWithoutObservations = (diagnostics = []) => draft({ mainCall: true, diagnostics });

/** A tool result of the call `toolUseId`. */
export const result = toolUseId => draft({
  observations: [{ type: 'tool-result', toolUseId, content: 'R', isError: false, resultMeta: { meta: null, error: null }, provenance: 'harness' }],
});

/** A harness message that brings a tool use and its result in one event. */
export const reads = toolUseId => draft({
  observations: [
    { type: 'tool-use', toolUseId, name: 'read', input: {}, provenance: 'harness' },
    { type: 'tool-result', toolUseId, content: 'R', isError: false, resultMeta: { meta: null, error: null }, provenance: 'harness' },
  ],
});

/** A true epoch boundary. */
export const boundary = () => draft({ observations: [{ type: 'epoch-boundary', provenance: 'harness' }] });

/** A carrier that seals `events`, given as builder results laid out in the log or as seqs. */
export const seal = (...events) => draft({ sealed: events });

/** The inputs of `events` in log order. */
export function sourceLog(events) {
  const seqOf = new Map(events.map((event, seq) => [event, seq]));
  return events.map((event, seq) => {
    const { sealed, observations, ...rest } = event;
    return {
      ...rest,
      seq,
      observations: observations.map(observation => ({ ...observation, sourceOrdinal: seq, sourceEntryId: String(seq), timestamp: seq })),
      ...(sealed === undefined ? {} : { sealed: sealed.map(cited => seqOf.get(cited) ?? cited) }),
    };
  });
}
