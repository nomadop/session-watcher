// public/lib/domH.js — the `h` of the dashboard: `(tag, props, ...children)` as an element of the page's `document`.
// `public/lib/fileRows.js` draws with it what the DSH tab draws with `React.createElement`. A prop is an attribute, set as its string unless it is null, undefined or false, `className` is the class attribute and `key` is no attribute; a child is a node, a string or a number (a text node), an array (flattened) or nothing (null, undefined or false).

function appendAll(element, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendAll(element, child);
    else if (typeof child === 'object') element.appendChild(child);
    else element.appendChild(document.createTextNode(String(child)));
  }
}

export function domH(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (name === 'key' || value == null || value === false) continue;
    element.setAttribute(name === 'className' ? 'class' : name, String(value));
  }
  appendAll(element, children);
  return element;
}
