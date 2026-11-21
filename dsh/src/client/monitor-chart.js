// dsh/src/client/monitor-chart.js — what the pages of the settlement drawer that draw a chart share: the text of a picture and the width of the element the chart is drawn in.
import React from 'react';
import { DEFAULT_CHART_WIDTH } from './monitor-state.js';

const h = React.createElement;

/** One text of a picture at `x`, `y`, reaching from there to the side `anchor` names. */
export const Label = ({ x, y, anchor, className, children }) => h('text', { className, x, y, textAnchor: anchor }, children);

/**
 * `[ref, width]`: the width of the element `ref` is given, kept as the element is resized, whatever it is, zero included. The observer follows the element through `ref`, so an element that mounts after the first render is measured as well and one that unmounts lets it go.
 * Until an element is measured, as in a server render, the width is `DEFAULT_CHART_WIDTH`.
 */
export function useElementWidth() {
  const [width, setWidth] = React.useState(DEFAULT_CHART_WIDTH);
  const observer = React.useRef(null);
  const ref = React.useCallback((element) => {
    observer.current?.disconnect();
    observer.current = null;
    if (element === null) return;
    setWidth(element.clientWidth);
    observer.current = new ResizeObserver(() => { setWidth(element.clientWidth); });
    observer.current.observe(element);
  }, []);
  return [ref, width];
}
