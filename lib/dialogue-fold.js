// lib/dialogue-fold.js — shared Dialogue Projection over normalized observations.
// It owns logical-message revisions, tool pairing, and line enumeration.
//
// Its whole input is an ordered observation array and its whole output is plain data: no Source is read,
// no path is resolved, and no native row, content block or tool name is interpreted here. The one native
// value it carries is a tool use's own `input` and working directory, handed on uninterpreted so the
// Harness Adapter above can resolve a target from the same pair a consumer will read.

/**
 * A logical Dialogue Message group, keyed by normalized `messageId`.
 *
 * `sourceOrdinal`/`sourceEntryId`/`timestamp` follow the FIRST row whose accumulated text is non-empty,
 * because that is the row a reader opens to see the message; a group that stays tool-only keeps the
 * coordinates of the row that created it.
 */
function createGroup(role, observation) {
  return {
    role,
    sourceOrdinal: observation.sourceOrdinal,
    // Empty is not a usable key — capture rejects a head carrying one — so it reaches a fold as no identity.
    sourceEntryId: observation.sourceEntryId || null,
    timestamp: observation.timestamp ?? null,
    text: null,
    hasVisibleText: false,
    // The row currently accumulating text, and its accumulation. One native row writes each content
    // block as its own observation, so the row's visible text is the concatenation of its text blocks —
    // and a later row bearing text supersedes the group's text wholesale.
    textRowOrdinal: null,
    rowText: '',
    toolUseIds: [],
    toolByUseId: new Map(),
  };
}

// A later row's text replaces the group's. A tool-only revision cannot erase text an earlier row supplied:
// it carries no text observation at all, so this never runs for it.
function absorbText(group, observation) {
  if (group.textRowOrdinal !== observation.sourceOrdinal) {
    group.textRowOrdinal = observation.sourceOrdinal;
    group.rowText = '';
  }
  group.rowText += observation.text;
  group.text = group.rowText;
  if (!group.hasVisibleText) {
    group.hasVisibleText = true;
    // Position moves to the row that bears the body. Identity and time fall back to whatever the group
    // already holds, so a fold reached through an identified, timed row loses neither to a later row that
    // carries no usable identity or no readable time.
    group.sourceOrdinal = observation.sourceOrdinal;
    group.sourceEntryId = observation.sourceEntryId || group.sourceEntryId;
    group.timestamp = observation.timestamp ?? group.timestamp;
  }
}

// First-seen id order with last-written payload: a revision of one tool use carries the same id and the
// row a reader should open is the one that wrote the payload that survived.
function absorbToolUse(group, observation) {
  const id = observation.toolUseId;
  if (!group.toolByUseId.has(id)) group.toolUseIds.push(id);
  group.toolByUseId.set(id, {
    name: observation.name,
    input: observation.input,
    cwd: observation.cwd ?? null,
    sourceOrdinal: observation.sourceOrdinal,
    sourceEntryId: observation.sourceEntryId ?? null,
    timestamp: observation.timestamp ?? null,
  });
}

/**
 * Project one ordered observation array into ordered, anchor-free Dialogue folds.
 *
 * Human text is dialogue exactly where its row also emitted a `turn-boundary`: every other `human` text
 * observation belongs to a row the harness wrote back into the model's own turn, and the boundary
 * observation is the shared fact that says so. Nothing here re-derives that rule from a native field.
 *
 * @param {object[]} observations - normalized observations in source order
 * @returns {{ folds: object[] }} folds in canonical order; each carries its own source coordinates
 */
export function projectDialogue(observations) {
  const groups = [];
  const assistantGroups = new Map();
  // Keyed by tool use id so a repeated result overwrites the earlier payload — same id is last-wins. A
  // list plus findIndex would take the first occurrence instead.
  const pendingResults = new Map();
  // The row of the most recent `turn-boundary`. Observations of one native row are contiguous and the
  // boundary precedes that row's content, so equality of `sourceOrdinal` is what makes a human text
  // observation part of a human turn.
  let turnBoundaryOrdinal = null;
  let openHumanGroup = null;

  for (const observation of observations) {
    if (observation.type === 'turn-boundary') {
      turnBoundaryOrdinal = observation.sourceOrdinal;
      continue;
    }
    if (observation.type === 'text') {
      if (observation.role === 'assistant') {
        openHumanGroup = null;
        let group = assistantGroups.get(observation.messageId);
        if (!group) {
          group = createGroup('assistant', observation);
          assistantGroups.set(observation.messageId, group);
          groups.push(group);
        }
        absorbText(group, observation);
        continue;
      }
      if (observation.sourceOrdinal !== turnBoundaryOrdinal) continue;
      if (!openHumanGroup || openHumanGroup.sourceOrdinal !== observation.sourceOrdinal) {
        openHumanGroup = createGroup('human', observation);
        // A human row is its own fold: revisions belong to the model's streaming snapshots, so a human
        // group is never keyed by `messageId` and never reopened by a later row.
        openHumanGroup.hasVisibleText = true;
        openHumanGroup.text = '';
        groups.push(openHumanGroup);
      }
      openHumanGroup.rowText += observation.text;
      openHumanGroup.text = openHumanGroup.rowText;
      continue;
    }
    if (observation.type === 'tool-use') {
      openHumanGroup = null;
      // An empty id names nothing, so there is no call to show and nothing a result could pair with. The
      // judgement is Dialogue's alone: Measurement counts every tool use its step issued and correlates by
      // the id it was given, so the observation is declined here rather than at the Source.
      if (!observation.toolUseId) continue;
      let group = assistantGroups.get(observation.messageId);
      if (!group) {
        group = createGroup('assistant', observation);
        assistantGroups.set(observation.messageId, group);
        groups.push(group);
      }
      absorbToolUse(group, observation);
      continue;
    }
    if (observation.type === 'tool-result') {
      openHumanGroup = null;
      if (!observation.toolUseId) continue;
      pendingResults.set(observation.toolUseId, observation);
    }
  }

  const folds = groups.map((group, ordinal) => ({
    ordinal,
    role: group.role,
    sourceOrdinal: group.sourceOrdinal,
    sourceEntryId: group.sourceEntryId,
    timestamp: group.timestamp,
    // message===null is how a tool-only fold says "no visible body here". Its tool evidence still
    // travels, and every line consumer walks it the same way.
    message: group.hasVisibleText ? { role: group.role, text: group.text } : null,
    toolPairs: group.toolUseIds.map(id => pairFor(id, group.toolByUseId.get(id), pendingResults)),
  }));

  return { folds };
}

function pairFor(toolUseId, use, pendingResults) {
  const result = pendingResults.get(toolUseId);
  // A result is consumed by the first fold that claims its id, so a later reuse of that id pairs with
  // nothing rather than inheriting the earlier payload.
  if (result !== undefined) pendingResults.delete(toolUseId);
  return {
    toolUseId,
    name: use.name,
    input: use.input,
    // The row that issued the surviving payload — the row `T` names for this line.
    sourceOrdinal: use.sourceOrdinal,
    sourceEntryId: use.sourceEntryId,
    timestamp: use.timestamp,
    // A tool use's own working directory, carried uninterpreted: the Harness Adapter resolves the native
    // target from this pair and attaches the `resourceKey` shared Turn History reads.
    cwd: use.cwd,
    resourceKey: null,
    // null means "no result row paired with this tool use", which is not the same as a result row that
    // carried no annotation — that one has a `resultMeta` whose annotation is absent.
    result: result === undefined ? null : result.content,
    // undefined means "no native is_error to report"; an unpaired tool use has none either.
    isError: result === undefined ? undefined : result.isError,
    resultMeta: result === undefined ? null : result.resultMeta,
    resultSourceOrdinal: result === undefined ? null : result.sourceOrdinal,
    resultSourceEntryId: result === undefined ? null : (result.sourceEntryId ?? null),
    resultTimestamp: result === undefined ? null : (result.timestamp ?? null),
  };
}

/**
 * The lines of ONE fold — the single definition of what counts as a line: one `visible` line when the
 * fold has a body, then one `tool` line per pair in `toolPairs` order.
 *
 * Every line carries its OWN source coordinates. A body's are its fold's; a tool line's are the tool
 * use's own row, because a message spreads its content blocks over rows and the row a reader opens for a
 * call is the one the call was written on.
 *
 * @param {object} fold - one element of projectDialogue's folds
 * @returns {object[]}
 */
export function dialogueFoldLines(fold) {
  const lines = [];
  if (fold.message) {
    lines.push({
      kind: 'visible',
      foldOrdinal: fold.ordinal,
      sourceOrdinal: fold.sourceOrdinal,
      sourceEntryId: fold.sourceEntryId,
      timestamp: fold.timestamp,
      message: fold.message,
      tool: null,
    });
  }
  for (const tool of fold.toolPairs || []) {
    lines.push({
      kind: 'tool',
      foldOrdinal: fold.ordinal,
      sourceOrdinal: tool.sourceOrdinal,
      sourceEntryId: tool.sourceEntryId,
      timestamp: tool.timestamp,
      message: null,
      tool,
    });
  }
  return lines;
}

/**
 * Enumerate a whole projection as lines: dialogueFoldLines over folds, in canonical order. Every line
 * consumer resolves a fold through this one traversal, so no second answer to "what is a line" can
 * appear without changing this one.
 *
 * @param {object[]} folds - projectDialogue's folds
 * @returns {object[]}
 */
export function enumerateDialogueLines(folds) {
  if (!Array.isArray(folds)) return [];
  return folds.flatMap(fold => dialogueFoldLines(fold));
}
