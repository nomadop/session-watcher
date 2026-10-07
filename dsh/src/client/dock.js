// dsh/src/client/dock.js — the `conversation.composer.dock` entry: a lamp ring with the bill premium as one pill, and the position, context stock and alert clock behind it one click away.
import React from 'react';
import { formatBr, formatU, formatDelta, formatPhase, phasePercent, formatTokens } from '../../../public/lib/format.js';
import { computeLandmarkPositions, projectedX } from '../../../public/lib/xScale.js';
import { resultSignalState, stateText } from './locales.js';

const h = React.createElement;

/** The viewport margin the popover's placement clamp keeps, the host's stat dialog's. */
const PANEL_MARGIN = 12;
/** The distance between the pill's top edge and the popover's bottom, the host's stat dialog's. */
const PANEL_GAP = 8;
/** The unplaced popover: laid out but hidden, so the placement measures its real size before it shows. */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
/** The highest bill premium the pill prints: br has no upper bound, and the cap keeps the pill's text short. */
const PILL_BR_CAP = 0.99;
/** The highest lap count the badge prints before it reads `99+`. */
const BADGE_CAP = 99;
/** The track's axis runs from the reference's origin to this multiple of the distance from the origin to the red band's near edge, so the red band draws as a band and not a point. */
const TRACK_SPAN = 1.25;

/** The arm glyph's paths on a 16×16 box, the grid of the host's icons: a trend line ending in an arrowhead, falling for the left arm, where the bill premium falls as the session goes on, rising for the right arm, where it rises. */
const ARROWS = { left: 'M1.5 4.5 5.5 8.5 8 6 13.5 11.5M10 11.5h3.5V8', right: 'M1.5 11.5 5.5 7.5 8 10 13.5 4.5M10 4.5h3.5V8' };

/**
 * The lamp ring: a track, the clock's arc of `arc` percent when above zero, and a core of the lamp's `zone`.
 * An `idle` clock dashes the track.
 */
function ring(zone, arc, idle) {
  return h('svg', { className: 'sw-lamp', 'data-zone': zone, 'data-idle': idle ? '' : undefined, width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': 'true' },
    h('circle', { className: 'trk', cx: 7, cy: 7, r: 5.5, pathLength: 100 }),
    arc > 0 ? h('circle', { className: 'arc', cx: 7, cy: 7, r: 5.5, pathLength: 100, transform: 'rotate(-90 7 7)', strokeDasharray: `${arc} 100` }) : null,
    h('circle', { className: 'core', cx: 7, cy: 7, r: 2 }));
}

/** A `<dt>` and `<dd>` pair, the label preceded by a colour swatch of the context stock's segment `swatch` when there is one. */
const row = (label, value, swatch) => h(React.Fragment, { key: label },
  h('dt', null, swatch === undefined ? null : h('i', { className: 'sw-sw', 'data-k': swatch }), label),
  h('dd', null, value));

/**
 * The position track on the dashboard's x axis: the four zone bands between the wire's landmarks, lit from the axis start to a marker where the reference puts the position, and a tick and label at the sweet spot; null unless the position the reference projects and the four landmarks are all finite.
 * The lit layer repeats the bands under a clip at the marker, so the bands the position has passed show whole and the one it stands in shows up to it.
 * The last band runs to the axis end. The wall landmark is not drawn, so `wallP` is passed only to satisfy `computeLandmarkPositions`.
 */
function track(rateLamp, t) {
  const { reference, xSweet, xBrAmberL, xBrAmberR, xBrRedR } = rateLamp;
  const x = projectedX(reference, rateLamp.u);
  if (![x, xSweet, xBrAmberL, xBrAmberR, xBrRedR].every(Number.isFinite)) return null;
  const minX = reference.a;
  const { markerPct, brAmberLPct, sweetPct, brAmberRPct, brRedRPct } = computeLandmarkPositions({
    domain: { minX, maxX: minX + (xBrRedR - minX) * TRACK_SPAN }, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP: xBrRedR, x,
  });
  const bands = [['white', 0, brAmberLPct], ['green', brAmberLPct, brAmberRPct], ['amber', brAmberRPct, brRedRPct], ['red', brRedRPct, 100]]
    .map(([zone, from, to]) => h('i', { key: zone, 'data-zone': zone, style: { flex: (to - from).toFixed(2) } }));
  const sweetLeft = `${sweetPct.toFixed(2)}%`;
  return h(React.Fragment, null,
    h('div', { className: 'sw-track', 'aria-hidden': 'true' },
      bands,
      h('div', { className: 'sw-lit', style: { clipPath: `inset(0 ${(100 - markerPct).toFixed(2)}% 0 0)` } }, bands),
      h('s', { style: { left: sweetLeft } }),
      h('b', { style: { left: `${markerPct.toFixed(2)}%` } })),
    h('div', { className: 'sw-scale' }, h('span', { style: { left: sweetLeft } }, t('dock.sweet'))));
}

/** The context stock as one bar of two segments weighted by the rebuild baseline and the effective context, L less B capped at zero, and the rows that name them beside the smoothed growth. */
function contextStock(status, rateLamp, t) {
  const baseline = status.bDefault ?? status.B;
  const effective = Math.max(0, status.L - baseline);
  return h('div', { className: 'sw-sec' },
    h('div', { className: 'sw-ctx-h' }, h('span', null, t('dock.stock')), h('span', null, formatTokens(status.L))),
    h('div', { className: 'sw-stock', 'aria-hidden': 'true' }, h('i', { 'data-k': 'base', style: { flex: baseline } }), h('i', { 'data-k': 'eff', style: { flex: effective } })),
    h('dl', null, row(t('dock.baseline'), formatTokens(baseline), 'base'), row(t('dock.effective'), formatTokens(effective), 'eff')),
    h('dl', { className: 'sw-rows' }, row(t('dock.growth'), formatDelta(rateLamp.gEma))));
}

/**
 * The alert the panel keeps: the latest `lastStopEvent` with a message that a live result carried, else `previous`.
 * The server clears the event at the next human turn boundary, but the alert stays through that and through results that are not live, until a newer alert replaces it.
 * The panel shows it only while the alert clock's laps have reached the event's `billCount`: a context restart begins a fresh rent ledger that drops the event and starts the laps over, and the reminder no longer applies to the restarted context.
 */
export function latestAlert(previous, result) {
  const event = result?.kind === 'live' ? result.snapshot.status.rateLamp?.lastStopEvent : null;
  return event?.message ? event : previous;
}

/**
 * The dock components over the host's two placement hooks and portal.
 *
 * `DockView({ result, alert, t, open, onOpenChange })` renders a `<button data-sw-dock>` pill under every result.
 * A reading is a `live` result whose `rateLamp.reliable` is true and whose `br` is finite. Its pill is the ring, whose core is `status.lamp`'s zone and whose arc is the alert clock's progress, then the labelled bill premium capped at `PILL_BR_CAP`, a trend arrow for the arm (`u` below one is the left arm, the falling one), and a corner badge with the clock's lap count when it is above zero. The name, as `aria-label` and `title`, is one sentence with the real bill premium, the arm, the clock and the lap count.
 * Without a reading the pill is a white ring and one word: `Calibrating` for a live result, else the `signal.*` word the tab's badge shows.
 * With `open`, the popover `<div data-sw-dock role="dialog">` is portaled into `document.body`, placed above the pill by `useAnchoredPosition` and hidden until placed. Its header is the ring with the zone's name or the pill's word. A reading's body holds the bill premium and the position, the position track, the context stock, and the alert clock with `alert`, the latest alert event's message, under it while the clock's laps have reached the event's `billCount`. Without a reading the body is one line: the result's state text or, for a live result, that there is not enough data yet.
 * An outside pointer, through `useDismissOnOutsidePointer`, and Escape both call `onOpenChange(false)`. Both hooks run on every render in the same order.
 *
 * `Dock({ store, t })` renders `DockView` over the store's latest result, starting from `store.result`, with the alert `latestAlert` keeps, and owns `open`.
 *
 * @param {{ useAnchoredPosition: Function, useDismissOnOutsidePointer: Function, createPortal: (node: unknown, target: unknown) => unknown }} hooks
 */
export function createDock({ useAnchoredPosition, useDismissOnOutsidePointer, createPortal }) {
  function DockView({ result, alert, t, open, onOpenChange }) {
    const rootRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN });
    useDismissOnOutsidePointer(rootRef, open, onOpenChange, panelRef);
    React.useEffect(() => {
      if (!open) return undefined;
      const onKeyDown = (event) => { if (event.key === 'Escape') onOpenChange(false); };
      document.addEventListener('keydown', onKeyDown);
      return () => { document.removeEventListener('keydown', onKeyDown); };
    }, [open, onOpenChange]);

    const status = result?.kind === 'live' ? result.snapshot.status : null;
    const rateLamp = status?.rateLamp?.reliable === true && Number.isFinite(status.rateLamp.br) ? status.rateLamp : null;
    const meter = rateLamp?.rentMeter;
    const clockActive = meter?.depthActive === true;
    const laps = meter?.backstopLapCount;
    const arm = rateLamp?.u < 1 ? 'left' : 'right';
    const word = rateLamp !== null ? null : status !== null ? t('dock.calibrating') : t(`signal.${resultSignalState(result)}`);
    const clockValue = clockActive ? formatPhase(meter.depthProgress) : t('dock.clockIdle');
    const summary = rateLamp === null ? word : [
      `${t('dock.br')} ${formatBr(rateLamp.br)}`,
      t(arm === 'left' ? 'dock.armLeft' : 'dock.armRight'),
      `${t('dock.clock')} ${clockValue}`,
      ...(laps > 0 ? [t('dock.laps', { count: laps })] : []),
    ].join(t('dock.separator'));
    const name = t('dock.pill', { summary });
    const lamp = ring(rateLamp === null ? 'white' : status.lamp, clockActive ? phasePercent(meter.depthProgress) : 0, rateLamp !== null && !clockActive);
    const pill = h('button', {
      type: 'button',
      ref: rootRef,
      'data-sw-dock': '',
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
      'aria-label': name,
      title: name,
      onClick: () => onOpenChange(!open),
    },
    lamp,
    h('span', null, rateLamp === null ? word : `${t('dock.br')} ${formatBr(Math.min(rateLamp.br, PILL_BR_CAP))}`),
    rateLamp === null ? null : h('svg', { className: 'sw-arm', 'data-arm': arm, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: ARROWS[arm] })),
    laps > 0 ? h('span', { className: 'sw-count', 'data-hot': meter.depthHot ? '' : undefined, role: 'img', 'aria-label': t('dock.laps', { count: laps }) }, laps > BADGE_CAP ? `${BADGE_CAP}+` : laps) : null);
    if (!open) return pill;

    const failing = status === null && ['failed', 'unreachable'].includes(resultSignalState(result));
    const header = [
      h('div', { key: 'title', className: 'sw-title' },
        h('span', { className: 'sw-title-label' }, lamp, t('view.label')),
        h('span', { className: 'sw-title-value', 'data-tone': failing ? 'error' : undefined }, rateLamp === null ? word : t(`dock.zone.${status.lamp}`))),
      h('div', { key: 'rule', className: 'sw-title-rule' }),
    ];
    const body = rateLamp === null
      ? h('p', null, status === null ? stateText(result, t) : t('dock.insufficientData'))
      : h(React.Fragment, null,
        h('div', { className: 'sw-hero' },
          h('div', null, h('div', { className: 'sw-hero-fig' }, formatBr(rateLamp.br)), h('div', { className: 'sw-hero-cap' }, t('dock.br'))),
          h('div', { className: 'sw-hero-pos' }, h('span', { className: 'sw-hero-fig' }, formatU(rateLamp.u)), h('small', null, t('dock.u')))),
        track(rateLamp, t),
        contextStock(status, rateLamp, t),
        h('div', { className: 'sw-sec' },
          h('div', { className: 'sw-ctx-h' }, h('span', null, t('dock.clock')), h('span', null, clockValue)),
          clockActive ? h('div', { className: 'sw-bar', 'data-zone': status.lamp, 'aria-hidden': 'true' }, h('i', { style: { width: `${phasePercent(meter.depthProgress)}%` } })) : null,
          alert && laps >= alert.billCount ? h('div', { className: 'sw-alert', 'data-zone': status.lamp }, h('p', null, alert.message)) : null));
    // The panel element stays one `div` across both bodies, so an open popover keeps the element the placement hooks observe.
    const panel = h('div', {
      ref: panelRef, 'data-sw-dock': '', role: 'dialog', 'aria-label': t('dock.label'), style: position ?? MEASURE_STYLE,
    }, header, body);
    return h(React.Fragment, null, pill, createPortal(panel, document.body));
  }

  function Dock({ store, t }) {
    const [result, setResult] = React.useState(() => store.result);
    const [alert, setAlert] = React.useState(() => latestAlert(null, store.result));
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => store.subscribe((next) => {
      setResult(next);
      setAlert(previous => latestAlert(previous, next));
    }), [store]);
    return h(DockView, { result, alert, t, open, onOpenChange: setOpen });
  }

  return { Dock, DockView };
}
