// The file list of the evidence page and the handoff files page, `monitor-files.js`, rendered to a string over models `monitor-files-model.js` builds: the head, the groups, a file folded to its row and open to its lines, the foot, and what each control is told by the view state.
// A server render proves the markup and the attributes the style and the screen reader read, and the buttons' handlers are called over the element tree to show which action each hands the reducer; how the state then changes is the reducer's, which the model's tests cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { FilesView } from '../dsh/src/client/monitor-files.js';
import { carriedFilesOf, readFilesOf, createFilesState, reduceFiles } from '../dsh/src/client/monitor-files-model.js';

const t = (key, params) => (params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);
const textOf = html => html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The opening tags of the elements of class `className`, and one attribute of a tag. */
const tagsOf = (html, className) => [...html.matchAll(new RegExp(`<[a-z0-9]+\\s[^>]*class="${className}"[^>]*>`, 'g'))].map(([tag]) => tag);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const attrs = (html, className, name) => tagsOf(html, className).map(tag => attr(tag, name));

const run = (first, last, text = number => `line ${number}`) => ({ offset: first, lines: Array.from({ length: last - first + 1 }, (_, at) => ({ number: first + at, text: text(first + at) })) });
const noop = () => {};
const view = (model, state = createFilesState()) => renderToString(React.createElement(FilesView, { model, state, dispatch: noop, baseId: 'f', t }));
const idsOf = model => model.groups.flatMap(group => group.items).filter(item => item.kind === 'file').map(item => item.id);
const opened = (model, ids = idsOf(model)) => reduceFiles(createFilesState(), { type: 'expand', ids });

const LONG_PATH = `packages/${'x'.repeat(50)}/services/a.js`;
const CARRIED = {
  files: [
    { path: 'src/a.js', total: 40, state: 'readable', reason: null, runs: [run(1, 2, number => `<b>${number}</b>`), run(10, 10)], withdrawn: [{ first: 5, last: 7 }] },
    { path: 'src/m.js', total: null, state: 'unreadable', reason: 'binary', runs: [], withdrawn: [] },
    { path: LONG_PATH, total: 3, state: null, reason: null, runs: [run(1, 3)], withdrawn: [] },
  ],
  removed: ['src/old.js'],
  skills: [{ name: 'tdd', text: 'Test first.\n\nThen build.' }, { name: 'grill', removed: true }],
  note: 'The <note> of B.',
  text: 'B <text>\nwhole',
};
const MODEL = carriedFilesOf(CARRIED, t);

// The rows of an open file as `[kind, ...]`: a line `['line', number, text]`, a gap or withdrawn row `['sep' | 'wd', text]`.
function rowsOf(body) {
  return body.split(/(?=<div class="sw-fl-(?:row|sep|wd)">)/).filter(chunk => /^<div class="sw-fl-(?:row|sep|wd)">/.test(chunk)).map((chunk) => {
    if (chunk.startsWith('<div class="sw-fl-row">')) return ['line', textOf(/<div class="sw-fl-n">(.*?)<\/div>/s.exec(chunk)[1]), textOf(/<div class="sw-fl-t">(.*?)<\/div>/s.exec(chunk)[1])];
    return [chunk.startsWith('<div class="sw-fl-sep">') ? 'sep' : 'wd', textOf(chunk.replace(/<\/div>.*$/s, ''))];
  });
}
// The markup of the items of `kind` (`file` or `plain`), each cut at its own end: a plain item is one row, a file item runs to the next item or group.
const itemsOf = (html, kind) => [...html.matchAll(new RegExp(`<div class="sw-fl-item" data-kind="${kind}"(.*?)(?=<div class="sw-fl-item"|</section>)`, 'gs'))].map(([, markup]) => markup);
// The markup of the body that the button `controls` names.
const bodyOf = (html, id) => new RegExp(`<div id="${id}">(.*?)</div></div><(?:/div|div class="sw-fl-item"|section)`, 's').exec(html)?.[1];

test('a new evidence list has its head, every group open and every file folded to its row, no line of any file, and the foot folded', () => {
  const html = view(MODEL);

  assert.deepEqual(attrs(html, 'sw-fl', 'data-sw-files'), ['carried']);
  assert.deepEqual(attrs(html, 'sw-fl-group', 'data-group'), ['changed', 'bare', 'gone', 'skills']);
  assert.deepEqual(attrs(html, 'sw-fl-gbtn', 'aria-expanded'), ['true', 'true', 'true', 'true']);
  assert.deepEqual(attrs(html, 'sw-fl-fbtn', 'aria-expanded'), ['false', 'false', 'false'], 'the two changed files and the skill');
  assert.equal(html.includes('sw-fl-rows'), false);
  assert.deepEqual(attrs(html, 'sw-fl-foldbtn', 'aria-expanded'), ['false', 'false']);
  assert.equal(html.includes('<pre') || html.includes('of B.'), false, 'the foot shows nothing while folded');
  assert.equal(html.includes('data-wrap'), false, 'the wrapping belongs to the lines of an open file');
});

test('the head says what the page holds: the lines written and withdrawn and the changed files, each in the tone of its kind, and what else the carrier says', () => {
  const html = view(MODEL);

  assert.equal(textOf(/<p class="sw-fl-sum">(.*?)<\/p>/.exec(html)[1]), 'monitor.files.summary.written(count=6) · monitor.files.summary.withdrawn(count=3) · monitor.files.summary.files(count=2)');
  assert.deepEqual([...html.matchAll(/<p class="sw-fl-sum">(.*?)<\/p>/g)][0][1].match(/data-tone="(\w+)"/g), ['data-tone="ok"', 'data-tone="warn"']);
  assert.equal(textOf(/<p class="sw-fl-sub">(.*?)<\/p>/.exec(html)[1]),
    'monitor.files.sub.more(parts=monitor.files.sub.skills(count=1) · monitor.files.sub.bare(count=1) · monitor.files.sub.gone(count=2))');
  assert.equal(html.includes('sw-fl-sub'), true);
  // A name with no directory shares no root.
  const plain = view(carriedFilesOf({ files: [{ ...CARRIED.files[0], path: 'a.js' }], removed: [], skills: [] }, t));
  assert.equal(plain.includes('sw-fl-sub'), false, 'no line for what the carrier does not say');
});

test('a folded file is its path, its count and one line under it: the bar of where its lines lie and its statistics, the reason in the place of both where it has no lines', () => {
  const html = view(MODEL);
  const [a, long] = itemsOf(html, 'file');

  assert.equal(textOf(/<span class="sw-fl-cnt">(.*?)<\/span><span class="sw-fl-pv"/.exec(a)[1]), '+3−3');
  assert.deepEqual(a.match(/data-tone="(\w+)"/g).slice(0, 2), ['data-tone="ok"', 'data-tone="warn"'], 'a written count in the success tone, a withdrawn one in the warning tone');
  const bar = /<span class="sw-fl-bar"[^>]*>(.*?)<\/span>/.exec(a)[1];
  assert.deepEqual([...bar.matchAll(/<i\b([^>]*)><\/i>/g)].map(([, tag]) => [attr(` ${tag}`, 'data-x'), attr(` ${tag}`, 'style')]), [
    [undefined, 'left:0%;width:5%'], [undefined, 'left:22.5%;width:2.5%'], ['', 'left:10%;width:7.5%'],
  ]);
  assert.equal(attr(tagsOf(a, 'sw-fl-bar')[0], 'title'), 'monitor.files.bar.written(spans=1–2, 10) · monitor.files.bar.withdrawn(spans=5–7)');
  assert.equal(textOf(/<span class="sw-fl-stat"[^>]*>(.*?)<\/span><\/span><\/button>/s.exec(a)[1]), 'monitor.files.segments(count=2) · monitor.files.chars(count=23)');
  assert.equal(tagsOf(a, 'sw-fl-path')[0].includes('title="src/a.js"'), true, 'the whole path is the tooltip');
  assert.deepEqual(attrs(html, 'sw-fl-pv', 'data-nobar'), [undefined, undefined, ''], 'a row with no bar, a skill\'s, is marked for the style to give its statistics the whole line');

  assert.equal(textOf(/<span class="sw-fl-path"[^>]*>(.*?)<\/span><span class="sw-fl-cnt">/s.exec(long)[1]), 'packages/…/services/a.js');
  assert.equal(attr(tagsOf(long, 'sw-fl-path')[0], 'title'), LONG_PATH);
});

test('an open file shows its meta line and its rows in the order of the file, a line its number and text, the lines no run shows and the withdrawn ones each said once; the markup in a line is text', () => {
  const html = view(MODEL, opened(MODEL));
  const [button] = tagsOf(html, 'sw-fl-fbtn');
  const body = bodyOf(html, attr(button, 'aria-controls'));

  assert.equal(attr(button, 'aria-expanded'), 'true');
  assert.equal(textOf(/<div class="sw-fl-meta">(.*?)<\/div><div class="sw-fl-scroll"/s.exec(body)[1]), 'monitor.files.meta.total(count=40) · monitor.files.meta.lines(spans=1–2, 10)');
  assert.deepEqual(rowsOf(body), [
    ['line', '1', '<b>1</b>'], ['line', '2', '<b>2</b>'],
    ['sep', 'monitor.files.row.gap(range=3–4)'],
    ['wd', '−monitor.files.row.withdrawn(range=5–7,count=3)'],
    ['sep', 'monitor.files.row.gap(range=8–9)'],
    ['line', '10', 'line 10'],
    ['sep', 'monitor.files.row.gap(range=11–40)'],
  ]);
  assert.equal(body.includes('<b>'), false, 'the markup characters are escaped');
  assert.equal(html.includes('data-open'), true);
});

test('a skill opens to its text line by line with no line number and its blank lines kept, and a path shown cut opens with the whole path above its meta line', () => {
  const html = view(MODEL, opened(MODEL));
  const items = itemsOf(html, 'file');
  const skill = items.find(item => item.includes('data-skill'));
  const long = items.find(item => item.includes(LONG_PATH));

  assert.deepEqual(rowsOf(skill), [['line', '', 'Test first.'], ['line', '', ''], ['line', '', 'Then build.']]);
  assert.equal(skill.includes('sw-fl-meta'), false, 'a skill has no meta line');
  assert.equal(textOf(/<div class="sw-fl-full">(.*?)<\/div>/.exec(long)[1]), LONG_PATH);
  assert.equal(items.filter(item => item.includes('sw-fl-full')).length, 1, 'only the cut path is repeated whole');
});

test('every control names the region it controls only while that region is shown, and the names are unique over the list', () => {
  const folded = view(MODEL);
  assert.deepEqual(attrs(folded, 'sw-fl-fbtn', 'aria-controls'), [undefined, undefined, undefined]);
  assert.deepEqual(attrs(folded, 'sw-fl-foldbtn', 'aria-controls'), [undefined, undefined]);

  const state = reduceFiles(reduceFiles(reduceFiles(opened(MODEL), { type: 'fold', key: 'note' }), { type: 'fold', key: 'text' }), { type: 'group', id: 'bare' });
  const html = view(MODEL, state);
  const controls = [...attrs(html, 'sw-fl-gbtn', 'aria-controls'), ...attrs(html, 'sw-fl-fbtn', 'aria-controls'), ...attrs(html, 'sw-fl-foldbtn', 'aria-controls')].filter(id => id !== undefined);
  assert.equal(controls.length, 3 + 3 + 2, 'the closed group names none');
  assert.equal(new Set(controls).size, controls.length);
  for (const id of controls) assert.equal(html.split(`id="${id}"`).length, 2, id);
});

test('a closed group shows its heading and the count of its files and none of them', () => {
  const html = view(MODEL, reduceFiles(createFilesState(), { type: 'group', id: 'bare' }));
  const gbtn = tagsOf(html, 'sw-fl-gbtn');

  assert.deepEqual(gbtn.map(tag => attr(tag, 'aria-expanded')), ['true', 'false', 'true', 'true']);
  assert.equal(html.includes('monitor.files.unreadable'), false, 'the unreadable file of that group is not listed');
  assert.equal(textOf(/<section class="sw-fl-group" data-group="bare">(.*?)<\/h3>/s.exec(html)[1]), 'monitor.files.group.bare1');
});

test('a file with no lines is one row with its reason at the end, no button to fold it, and the tone and the strike of what it says', () => {
  const html = view(MODEL);
  const plain = itemsOf(html, 'plain');

  assert.equal(plain.length, 2 + 1 + 0, 'the unreadable file, the removed path and the removed skill');
  assert.equal(plain.some(item => item.includes('sw-fl-fbtn')), false);
  const [unreadable, removed, removedSkill] = plain;
  assert.equal(textOf(/<span class="sw-fl-why"[^>]*>(.*?)<\/span>/.exec(unreadable)[1]), 'monitor.files.unreadable(reason=monitor.files.reason.binary)');
  assert.equal(attr(tagsOf(unreadable, 'sw-fl-why')[0], 'data-tone'), 'err');
  assert.deepEqual([unreadable, removed, removedSkill].map(item => item.startsWith(' data-removed=""')), [false, true, true]);
  assert.equal(attr(tagsOf(removed, 'sw-fl-why')[0], 'data-tone'), undefined);
  assert.deepEqual(attrs(html, 'sw-fl-why', 'data-long'), ['', '', ''], 'a reason as long as these keys does not share the line with the path');
  assert.deepEqual(attrs(view(carriedFilesOf(CARRIED, () => 'ok')), 'sw-fl-why', 'data-long'), [undefined, undefined, undefined]);
});

test('the head controls are the three of the page, named and pressed by the state: expand all has nothing to do once every file is open, collapse all while none is, and the wrap switch follows the wrapping', () => {
  const stateOf = (html) => {
    const [expand, collapse, wrap] = tagsOf(html, 'sw-fl-btn');
    return [expand, collapse, wrap];
  };
  const [expand, collapse, wrap] = stateOf(view(MODEL));
  assert.deepEqual([attr(expand, 'data-act'), attr(collapse, 'data-act'), attr(wrap, 'data-act')], ['expand', 'collapse', 'wrap']);
  assert.deepEqual([attr(expand, 'aria-label'), attr(collapse, 'aria-label'), attr(wrap, 'aria-label')], ['monitor.files.expandAll', 'monitor.files.collapseAll', 'monitor.files.wrap']);
  assert.deepEqual([attr(expand, 'aria-disabled'), attr(collapse, 'aria-disabled'), attr(wrap, 'aria-pressed'), attr(wrap, 'title')], [undefined, 'true', 'true', 'monitor.files.wrap.on']);
  assert.deepEqual([attr(expand, 'aria-pressed'), attr(collapse, 'aria-pressed')], [undefined, undefined], 'only the wrap switch is a toggle');
  assert.equal([expand, collapse, wrap].some(tag => /\sdisabled\b/.test(tag)), false, 'a control with nothing to do keeps its place in the tab order');

  const [expandAll, collapseAll] = stateOf(view(MODEL, opened(MODEL)));
  assert.deepEqual([attr(expandAll, 'aria-disabled'), attr(collapseAll, 'aria-disabled')], ['true', undefined]);
  const [expandSome, collapseSome] = stateOf(view(MODEL, opened(MODEL, ['changed:0'])));
  assert.deepEqual([attr(expandSome, 'aria-disabled'), attr(collapseSome, 'aria-disabled')], [undefined, undefined]);

  const unwrapped = view(MODEL, reduceFiles(createFilesState(), { type: 'wrap' }));
  const [, , off] = stateOf(unwrapped);
  assert.deepEqual([attr(off, 'aria-pressed'), attr(off, 'title')], ['false', 'monitor.files.wrap.off']);
  assert.deepEqual(attrs(view(MODEL, opened(MODEL)), 'sw-fl-scroll', 'data-wrap'), ['on', 'on', 'on'], 'the lines of every open file wrap');
  assert.deepEqual(attrs(view(MODEL, reduceFiles(opened(MODEL), { type: 'wrap' })), 'sw-fl-scroll', 'data-wrap'), ['off', 'off', 'off'], 'and none does once the switch is off');
});

test('the foot folds show their text once open: the note as a paragraph and B\'s whole text in a preformatted block, markup shown and not interpreted', () => {
  const html = view(MODEL, reduceFiles(reduceFiles(createFilesState(), { type: 'fold', key: 'note' }), { type: 'fold', key: 'text' }));

  assert.deepEqual(attrs(html, 'sw-fl-foldbtn', 'aria-expanded'), ['true', 'true']);
  const [note, text] = html.split('<div class="sw-fl-fold">').slice(1);
  assert.equal(textOf(/<p>(.*?)<\/p>/.exec(note)[1]), 'The <note> of B.');
  assert.equal(textOf(/<pre class="sw-mon-pre">(.*?)<\/pre>/s.exec(text)[1]), 'B <text>\nwhole');
  assert.equal(html.includes('<note>') || html.includes('<text>'), false);
});

// ── The files page ────────────────────────────────────────────────────────────

const FILES = [
  { path: '/work/src/a.js', total: 100, runs: [run(1, 2), run(50, 50)] },
  { path: '/work/old/c.js', total: null, runs: [] },
  { path: '/work/old/e.js', total: 0, runs: [] },
];

test('the files page is one group of the files read under the root they share, a file with lines folded to its row and a file the load recorded in no readable form a row of its own that says so', () => {
  const model = readFilesOf(FILES, t);
  const html = view(model);

  assert.deepEqual(attrs(html, 'sw-fl', 'data-sw-files'), ['read']);
  assert.deepEqual(attrs(html, 'sw-fl-group', 'data-group'), ['read']);
  assert.equal(textOf(/<p class="sw-fl-sum">(.*?)<\/p>/.exec(html)[1]), 'monitor.files.summary.files(count=3) · monitor.files.lines(count=3) · monitor.files.segments(count=2)');
  assert.equal(textOf(/<p class="sw-fl-sub">(.*?)<\/p>/.exec(html)[1]), 'monitor.files.sub.root(root=/work)');
  assert.equal(attrs(html, 'sw-fl-fbtn', 'aria-expanded').length, 1);
  assert.equal(textOf(/<span class="sw-fl-cnt">(.*?)<\/span>/.exec(html)[1]), 'monitor.files.lines(count=3)');
  assert.deepEqual([...html.matchAll(/<span class="sw-fl-why"[^>]*>(.*?)<\/span>/g)].map(([, why]) => textOf(why)), ['monitor.files.unrecorded', 'monitor.files.empty']);
  assert.equal(html.includes('sw-fl-foot'), false);

  const open = view(model, opened(model));
  assert.deepEqual(rowsOf(open), [
    ['line', '1', 'line 1'], ['line', '2', 'line 2'], ['sep', 'monitor.files.row.gap(range=3–49)'], ['line', '50', 'line 50'], ['sep', 'monitor.files.row.gap(range=51–100)'],
  ]);
});

// ── What the buttons dispatch ─────────────────────────────────────────────────

// The element tree one render of `FilesView` describes, its function components called with their props down to the bodies of open files, which hold a hook and stay elements.
function resolved(node) {
  if (Array.isArray(node)) return node.map(resolved);
  if (node === null || typeof node !== 'object') return node;
  const { type, props } = node;
  if (typeof type === 'function' && type.name !== 'FileBody') return resolved(type(props));
  return { ...node, props: { ...props, children: resolved(props.children) } };
}
const buttonsOf = (node, found = []) => {
  if (Array.isArray(node)) node.forEach(child => buttonsOf(child, found));
  else if (node !== null && typeof node === 'object') {
    if (node.type === 'button') found.push(node.props);
    buttonsOf(node.props.children, found);
  }
  return found;
};

/** The actions each button of a render hands to `dispatch` when clicked, by its class and `data-act`. */
function clicked(model, state) {
  const actions = [];
  const tree = resolved(FilesView({ model, state, dispatch: action => actions.push(action), baseId: 'f', t }));
  const dispatched = [];
  for (const props of buttonsOf(tree)) {
    actions.length = 0;
    props.onClick();
    dispatched.push([props.className, props['data-act'], [...actions]]);
  }
  return dispatched;
}

test('each button hands the reducer the action of its own: the controls the whole list, a group, a file and a fold of the foot their own id or key, and a control with nothing to do hands none', () => {
  const ids = idsOf(MODEL);
  assert.deepEqual(clicked(MODEL, createFilesState()), [
    ['sw-fl-btn', 'expand', [{ type: 'expand', ids }]],
    ['sw-fl-btn', 'collapse', []],
    ['sw-fl-btn', 'wrap', [{ type: 'wrap' }]],
    ['sw-fl-gbtn', undefined, [{ type: 'group', id: 'changed' }]],
    ['sw-fl-fbtn', undefined, [{ type: 'toggle', id: 'changed:0' }]],
    ['sw-fl-fbtn', undefined, [{ type: 'toggle', id: 'changed:1' }]],
    ['sw-fl-gbtn', undefined, [{ type: 'group', id: 'bare' }]],
    ['sw-fl-gbtn', undefined, [{ type: 'group', id: 'gone' }]],
    ['sw-fl-gbtn', undefined, [{ type: 'group', id: 'skills' }]],
    ['sw-fl-fbtn', undefined, [{ type: 'toggle', id: 'skills:0' }]],
    ['sw-fl-foldbtn', undefined, [{ type: 'fold', key: 'note' }]],
    ['sw-fl-foldbtn', undefined, [{ type: 'fold', key: 'text' }]],
  ]);
  const open = clicked(MODEL, opened(MODEL)).filter(([className]) => className === 'sw-fl-btn');
  assert.deepEqual(open, [['sw-fl-btn', 'expand', []], ['sw-fl-btn', 'collapse', [{ type: 'collapse' }]], ['sw-fl-btn', 'wrap', [{ type: 'wrap' }]]]);
});
