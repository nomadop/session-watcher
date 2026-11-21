// public/lib/drawerShell.js — the modal drawer that slides in from the right: a scrim, a dialog with a title row and a close button, and a body that scrolls.
// While it is open the page behind it (`.sw-wrap`) is inert, Escape and a click on the scrim close it, and focus goes into it on open and back to where the caller says on close. The History drawer and the file drawer are built on it; each fills `head` and `body` with its own content.
import { domH } from './domH.js';

/**
 * @param {{ overlayRoot: Element, title: string, closeLabel: string, className?: string }} options `overlayRoot` holds the scrim and the dialog; `className` is added to the dialog.
 * @returns {{ head: Element, body: Element, isOpen: () => boolean, setTitle: (text: string) => void,
 *   open: (options?: { focus?: Element, returnFocus?: Element | (() => Element | null) | null }) => void, close: () => void, destroy: () => void }}
 *   `open` focuses `focus` (the close button by default) and `close` focuses `returnFocus`, which may be a function that finds the element at that time; `setTitle` is the heading and the dialog's name.
 */
export function createDrawerShell({ overlayRoot, title, closeLabel, className = '' }) {
  let isOpen = false;
  let returnFocus = null;

  const scrim = domH('div', { className: 'sw-drawer-scrim', 'aria-hidden': 'true' });
  const titleEl = domH('h2', { className: 'sw-drawer-title' }, title);
  const closeBtn = domH('button', { className: 'sw-drawer-close', type: 'button', 'aria-label': closeLabel }, '×');
  const head = domH('header', { className: 'sw-drawer-head' }, domH('div', { className: 'sw-drawer-title-row' }, titleEl, closeBtn));
  const body = domH('div', { className: 'sw-drawer-body' });
  const drawer = domH('aside', {
    className: `sw-drawer ${className}`.trim(), role: 'dialog', 'aria-label': title, 'aria-modal': 'true',
  }, head, body);
  overlayRoot.appendChild(scrim);
  overlayRoot.appendChild(drawer);

  function open({ focus = closeBtn, returnFocus: back = null } = {}) {
    if (isOpen) return;
    isOpen = true;
    returnFocus = back;
    drawer.classList.add('sw-drawer-open');
    scrim.classList.add('sw-drawer-scrim-visible');
    scrim.setAttribute('aria-hidden', 'false');
    document.querySelector('.sw-wrap')?.setAttribute('inert', '');
    // Focus moves into the modal at once; otherwise the active element stays in the subtree that was just made inert.
    focus.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    drawer.classList.remove('sw-drawer-open');
    scrim.classList.remove('sw-drawer-scrim-visible');
    scrim.setAttribute('aria-hidden', 'true');
    document.querySelector('.sw-wrap')?.removeAttribute('inert');
    const target = typeof returnFocus === 'function' ? returnFocus() : returnFocus;
    returnFocus = null;
    target?.focus();
  }

  function onKeydown(event) {
    if (event.key !== 'Escape' || !isOpen) return;
    // Blink treats Escape on a non-empty input[type="search"] as a clear and applies it after this handler has moved focus, so the default is suppressed to keep such a field as the drawer left it.
    event.preventDefault();
    close();
  }
  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  return {
    head,
    body,
    isOpen: () => isOpen,
    setTitle(text) {
      titleEl.textContent = text;
      drawer.setAttribute('aria-label', text);
    },
    open,
    close,
    destroy() {
      document.removeEventListener('keydown', onKeydown);
      if (isOpen) document.querySelector('.sw-wrap')?.removeAttribute('inert');
      scrim.remove();
      drawer.remove();
    },
  };
}
