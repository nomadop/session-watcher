// dsh/src/client/monitor-files.js — the file list of the evidence page and the handoff files page: groups of files, each folded to its path, count, position bar and statistics and, open, its lines. The model is `monitor-files-model.js`; the view state is its reducer's.
import React from 'react';
import { PART_SEPARATOR } from './monitor-state.js';
import {
  carriedFilesOf, readFilesOf, createFilesState, reduceFiles, isFileOpen, isGroupOpen, isFootOpen, controlsOf,
} from './monitor-files-model.js';
import { bodyRowsOf, fileRows } from '../../../public/lib/fileRows.js';

const h = React.createElement;

// The strokes of each control's 16-unit icon: two chevrons pointing apart, two pointing together, and lines of text with a return arrow.
const ICONS = {
  expand: ['M4 6.5 8 3l4 3.5', 'M4 9.5 8 13l4-3.5'],
  collapse: ['M4 3 8 6.5 12 3', 'M4 13 8 9.5 12 13'],
  wrap: ['M2 3.5h12', 'M2 7.5h9.5a2.25 2.25 0 0 1 0 4.5H7.5', 'M9.3 10.2 7.3 12l2 1.8', 'M2 12h3'],
};

const Icon = ({ name }) => h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, ICONS[name].map(d => h('path', { key: d, d })));
const Chevron = () => h('i', { className: 'sw-fl-chev', 'aria-hidden': 'true' });
const toneOf = tone => tone ?? undefined;

// The three controls of the page head. A control with nothing to do stays in the tab order with `aria-disabled`, so a press that has just used it up does not lose the keyboard its focus.
function Controls({ state, ids, dispatch, t }) {
  const { expandDisabled, collapseDisabled } = controlsOf(state, ids);
  const button = (name, label, { disabled = false, pressed, title = label, action }) => h('button', {
    type: 'button',
    className: 'sw-fl-btn',
    'data-act': name,
    title,
    'aria-label': label,
    'aria-disabled': disabled ? 'true' : undefined,
    'aria-pressed': pressed,
    onClick: () => { if (!disabled) dispatch(action); },
  }, h(Icon, { name }));
  return h('span', { className: 'sw-fl-ctl', role: 'group', 'aria-label': t('monitor.files.controls') },
    button('expand', t('monitor.files.expandAll'), { disabled: expandDisabled, action: { type: 'expand', ids } }),
    button('collapse', t('monitor.files.collapseAll'), { disabled: collapseDisabled, action: { type: 'collapse' } }),
    button('wrap', t('monitor.files.wrap'), { pressed: state.wrap, title: t(state.wrap ? 'monitor.files.wrap.on' : 'monitor.files.wrap.off'), action: { type: 'wrap' } }));
}

// A path as the row shows it: its directory in the secondary tone, its name in the primary one, the whole path as the tooltip.
function Path({ item }) {
  const { dir, base } = item.name;
  return h('span', { className: 'sw-fl-path', title: item.path },
    dir === '' ? null : h('span', { className: 'sw-fl-dir' }, dir),
    h('span', { className: 'sw-fl-base' }, base));
}

// The line of a folded file under its path: the bar of where its lines lie in the file, and its statistics, which are the reason it has no lines where it has none.
function Preview({ item: { bar, stat } }) {
  return h('span', { className: 'sw-fl-pv', 'data-nobar': bar === null ? '' : undefined },
    bar === null ? null : h('span', { className: 'sw-fl-bar', title: bar.title, 'aria-hidden': 'true' },
      bar.marks.map((mark, at) => h('i', { key: at, 'data-x': mark.withdrawn ? '' : undefined, style: { left: `${mark.left}%`, width: `${mark.width}%` } }))),
    h('span', { className: 'sw-fl-stat', 'data-tone': toneOf(stat.empty?.tone) },
      stat.empty === null
        ? [stat.segments === null ? null : h('span', { key: 'segments', className: 'sw-fl-sg' }, `${stat.segments}${PART_SEPARATOR}`), stat.chars]
        : stat.empty.text));
}

// The body of an open file: the meta line, with the whole path first where the row shows it cut, then its lines, drawn by the rows module with this list's wording.
function FileBody({ item, id, wrap, t }) {
  const rows = React.useMemo(() => bodyRowsOf(item), [item]);
  const words = {
    gap: range => t('monitor.files.row.gap', { range }),
    withdrawn: (range, count) => t('monitor.files.row.withdrawn', { range, count }),
  };
  return h('div', { id },
    item.name.cut || item.meta !== '' ? h('div', { className: 'sw-fl-meta' }, item.name.cut ? h('div', { className: 'sw-fl-full' }, item.path) : null, item.meta) : null,
    fileRows(h, rows, words, wrap));
}

function FileItem({ item, open, bodyId, wrap, dispatch, t }) {
  return h('div', { className: 'sw-fl-item', 'data-kind': 'file', 'data-open': open ? '' : undefined, 'data-skill': item.skill ? '' : undefined },
    h('h4', { className: 'sw-fl-fh' },
      h('button', { type: 'button', className: 'sw-fl-fbtn', 'aria-expanded': open, 'aria-controls': open ? bodyId : undefined, onClick: () => dispatch({ type: 'toggle', id: item.id }) },
        h(Chevron),
        h(Path, { item }),
        h('span', { className: 'sw-fl-cnt' }, item.count.map(({ text, tone }) => h('span', { key: text, 'data-tone': toneOf(tone) }, text))),
        h(Preview, { item }))),
    open ? h(FileBody, { item, id: bodyId, wrap, t }) : null);
}

// A file with no lines to show: one line, its reason at its end, and nothing to fold.
function PlainItem({ item }) {
  return h('div', { className: 'sw-fl-item', 'data-kind': 'plain', 'data-removed': item.removed ? '' : undefined },
    h('div', { className: 'sw-fl-plain' },
      h(Path, { item }),
      h('span', { className: 'sw-fl-why', 'data-tone': toneOf(item.tone), 'data-long': item.long ? '' : undefined }, item.why)));
}

function Group({ group, state, baseId, dispatch, t }) {
  const open = isGroupOpen(state, group.id);
  const bodyId = `${baseId}-group-${group.id}`;
  return h('section', { className: 'sw-fl-group', 'data-group': group.id },
    h('h3', { className: 'sw-fl-gh' },
      h('button', { type: 'button', className: 'sw-fl-gbtn', 'aria-expanded': open, 'aria-controls': open ? bodyId : undefined, onClick: () => dispatch({ type: 'group', id: group.id }) },
        h(Chevron),
        h('span', { className: 'sw-fl-lbl' }, group.label),
        h('span', { className: 'sw-fl-gcnt' }, group.items.length))),
    open ? h('div', { id: bodyId }, group.items.map(item => (item.kind === 'file'
      ? h(FileItem, { key: item.id, item, open: isFileOpen(state, item.id), bodyId: `${baseId}-file-${item.id}`, wrap: state.wrap, dispatch, t })
      : h(PlainItem, { key: item.id, item })))) : null);
}

// The folds at the foot: each is its label, and its text once it is open.
function Foot({ foot, state, baseId, dispatch }) {
  return h('div', { className: 'sw-fl-foot' }, foot.map(({ key, label, text, pre }) => {
    const open = isFootOpen(state, key);
    const id = `${baseId}-foot-${key}`;
    return h('div', { key, className: 'sw-fl-fold' },
      h('button', { type: 'button', className: 'sw-fl-foldbtn', 'aria-expanded': open, 'aria-controls': open ? id : undefined, onClick: () => dispatch({ type: 'fold', key }) }, h(Chevron), label),
      open ? h('div', { id, className: 'sw-fl-foldbody' }, pre ? h('pre', { className: 'sw-mon-pre' }, text) : h('p', null, text)) : null);
  }));
}

/**
 * The list a model describes, under the view `state` of `reduceFiles` and its `dispatch`: the head with the summary and the three controls, the groups, and the folds of the model's foot, which are the evidence page's alone.
 * The root is a size container: the narrow rules follow the width the drawer gives it.
 */
export function FilesView({ model, state, dispatch, baseId = 'sw-files', t }) {
  const ids = model.groups.flatMap(group => group.items).filter(item => item.kind === 'file').map(item => item.id);
  return h('div', { className: 'sw-fl', 'data-sw-files': model.mode },
    h('div', { className: 'sw-fl-head' },
      h('p', { className: 'sw-fl-sum' }, model.summary.flatMap(({ text, tone }, at) => [at > 0 ? PART_SEPARATOR : null, h('span', { key: at, 'data-tone': toneOf(tone) }, text)])),
      h(Controls, { state, ids, dispatch, t }),
      model.sub === null ? null : h('p', { className: 'sw-fl-sub' }, model.sub)),
    h('div', { className: 'sw-fl-list' }, model.groups.map(group => h(Group, { key: group.id, group, state, baseId, dispatch, t }))),
    model.foot.length === 0 ? null : h(Foot, { foot: model.foot, state, baseId, dispatch }));
}

/** The evidence page's list over the `carried` of the `inner-monitor/call` detail, with the carrier's wording and B's whole text folded at its foot. */
export function CarriedFiles({ carried, t }) {
  const model = React.useMemo(() => carriedFilesOf(carried, t), [carried, t]);
  const [state, dispatch] = React.useReducer(reduceFiles, undefined, createFilesState);
  return h(FilesView, { model, state, dispatch, baseId: React.useId(), t });
}

/** The files page's list over the `files` of the `inner-monitor/handoff` detail. */
export function ReadFiles({ files, t }) {
  const model = React.useMemo(() => readFilesOf(files, t), [files, t]);
  const [state, dispatch] = React.useReducer(reduceFiles, undefined, createFilesState);
  return h(FilesView, { model, state, dispatch, baseId: React.useId(), t });
}
