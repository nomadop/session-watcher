// lib/inner-seal/state-block.js — the session state block of a carrier: the `state` field a seal carries and the text it renders to.
//
// The block stands outside the chain B forms: a `state` field holds the items the block displays, each with the value it shows,
// and is present exactly where the block displays any, so the most recent carrier source that holds an item is the value last
// shown for it (`carryState`). The items are the harness's table, handed in as `stateItems`: each `{ key, tool, label, multiline,
// normalize, isEmpty, same, text }` owns the tool whose answer it stands for (an item that stands for none has no `tool`), its
// whole line label, whether its text takes lines of its own under the label (`multiline`), the check and copy of the value a host
// reads for it (`normalize`, which refuses what the item cannot hold with an error), what makes that value empty, when two
// values are the same, and the text of a value. The block lists the shown items in the table's order.

/**
 * The state block's own model-visible wording. Each entry carries a required meaning and may be reworded without changing
 * it: the block states each item it shows as the tool or commands it stands for would show it; `empty` is
 * an item with none, even when it is the value last shown for that item, and a line that says its item is
 * unchanged leaves a value that is not empty to what was last shown for it.
 */
export const STATE_WORDING = {
  heading: () => 'Session state:',
  unchanged: 'unchanged since last shown',
  empty: '(empty)',
};

const checkedCut = (asOfSeq) => {
  if (!Number.isSafeInteger(asOfSeq)) throw new Error('the session state names no session seq as its cut');
  return asOfSeq;
};

// What `source` shows for `item`, `{ value }`, or undefined where its `state` holds none.
function shownIn(source, { key }) {
  return Object.hasOwn(source.state?.items ?? {}, key) ? { value: source.state.items[key].value } : undefined;
}

// The `{ value, unchanged? }` a carrier built now shows for `item` holding `value`, or null where it shows none: the first show of an empty item is left out, a value the nearest earlier source that shows the item has is shown as unchanged unless it is empty, any other whole. The value is copied.
function carryItem(item, value, earlier) {
  const current = item.normalize(value);
  const last = earlier.map(source => shownIn(source, item)).findLast(shown => shown !== undefined);
  if (last === undefined) return item.isEmpty(current) ? null : { value: current };
  return !item.isEmpty(current) && item.same(current, item.normalize(last.value)) ? { value: current, unchanged: true } : { value: current };
}

/**
 * The `state` field a carrier built now carries, `{ asOfSeq, items }`, or null where no item is shown. `read` is the host's: `asOfSeq`, the session seq its values are cut at, and `items`, for each item the host can read a function answering its value (an item without one is unavailable). An item of `stateItems` is read only when `tools`, the names of the tools the session lists, holds its tool; an item with no tool is read whatever `tools` holds. `earlier` are the sources the request holds ahead of the one being built, in order: each item is compared with the value the most recent of them whose `state` shows it shows; a value that is the same is marked unchanged unless it is empty, which is shown as empty; the cut is no part of a value.
 * An item whose read throws, whose value is not what the item holds or whose earlier value is not, is left out and handed to `failed(item, error)` once; the others stand. A cut that is no session seq is refused with an error.
 */
export function carryState({ asOfSeq, items }, { stateItems, tools, earlier, failed }) {
  checkedCut(asOfSeq);
  const shown = {};
  for (const item of stateItems) {
    const read = items[item.key];
    if (read === undefined || (item.tool !== undefined && !tools.has(item.tool))) continue;
    try {
      const carried = carryItem(item, read(), earlier);
      if (carried !== null) shown[item.key] = carried;
    } catch (error) {
      failed(item, error);
    }
  }
  return Object.keys(shown).length === 0 ? null : { asOfSeq, items: shown };
}

/**
 * The state block's text, without a break before it: the heading, then one line for each item of `stateItems` the `state` shows, in the table's order (a `multiline` item's text on the lines after its label), an item key the table does not hold having none. A value its item cannot hold or a cut that is no session seq is refused with an error, so no text stands in for it.
 * @returns {string}
 */
export function renderState({ asOfSeq, items }, stateItems) {
  const W = STATE_WORDING;
  const lines = stateItems.filter(({ key }) => Object.hasOwn(items, key)).map((item) => {
    const { value, unchanged = false } = items[item.key];
    const shown = item.normalize(value);
    if (item.isEmpty(shown)) return `${item.label} ${W.empty}`;
    if (unchanged) return `${item.label} ${W.unchanged}`;
    return `${item.label}${item.multiline === true ? '\n' : ' '}${item.text(shown)}`;
  });
  return [W.heading(checkedCut(asOfSeq)), ...lines].join('\n');
}
