// public/elements/themeChip.js — Theme switcher: color dot + popover (spec §1.1)

import { THEMES, STORAGE_KEY, resolveTheme, dotGradient } from '../lib/themeHelpers.js';

function getCurrentTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return resolveTheme(stored);
}

function applyTheme(themeId) {
  // Target the theme link specifically — index.html must have id="sw-theme-css" on the
  // theme <link> (not base.css). Fallback: second link[href*="themes/"] if id missing.
  const link = document.getElementById('sw-theme-css')
    || document.querySelectorAll('link[href*="themes/"]')[1];
  if (!link) return;
  const newHref = `themes/${themeId}.css`;
  // Skip if already on this theme (prevents infinite remount loop on mount)
  if (link.getAttribute('href') === newHref) return;
  // Signal elements to remount after new CSS loads (CSS vars changed)
  link.addEventListener('load', () => {
    localStorage.setItem(STORAGE_KEY, themeId);
    document.dispatchEvent(new CustomEvent('sw-theme-change', { detail: { themeId } }));
  }, { once: true });
  link.href = newHref;
}

export function mount(root, _ctx) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sw-theme-wrapper';

  const dot = document.createElement('button');
  dot.className = 'sw-theme-dot';
  dot.setAttribute('aria-label', 'Switch theme');
  dot.setAttribute('aria-expanded', 'false');

  const popover = document.createElement('div');
  popover.className = 'sw-theme-popover';
  popover.style.display = 'none';

  // Build popover rows
  for (const theme of THEMES) {
    const row = document.createElement('button');
    row.className = 'sw-theme-row';
    row.dataset.theme = theme.id;
    row.innerHTML = `
      <span class="sw-theme-swatches">${theme.colors.map(c => `<span style="background:${c}"></span>`).join('')}</span>
      <span class="sw-theme-letter">${theme.label}</span>
    `;
    popover.appendChild(row);
  }

  wrapper.appendChild(dot);
  wrapper.appendChild(popover);

  // Insert into chrome bar, after the tag (.sw-chrome-tag), before spacer.
  // Note: .sw-chrome-spacer lives inside .sw-chrome-bar (child of root), not directly on root.
  const bar = root.querySelector('.sw-chrome-bar');
  const spacer = bar?.querySelector('.sw-chrome-spacer');
  if (bar && spacer) {
    bar.insertBefore(wrapper, spacer);
  } else {
    root.appendChild(wrapper);
  }

  // Set initial dot gradient
  const current = getCurrentTheme();
  const currentTheme = THEMES.find(t => t.id === current) || THEMES[4];
  dot.style.background = dotGradient(currentTheme.colors);

  let popoverOpen = false;

  function openPopover() {
    popoverOpen = true;
    popover.style.display = 'flex';
    dot.setAttribute('aria-expanded', 'true');
  }

  function closePopover() {
    popoverOpen = false;
    popover.style.display = 'none';
    dot.setAttribute('aria-expanded', 'false');
  }

  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popoverOpen) closePopover();
    else openPopover();
  });

  popover.addEventListener('click', (e) => {
    const row = e.target.closest('.sw-theme-row');
    if (!row) return;
    const themeId = row.dataset.theme;
    applyTheme(themeId);
    const theme = THEMES.find(t => t.id === themeId);
    if (theme) dot.style.background = dotGradient(theme.colors);
    closePopover();
  });

  function onDocumentClick(e) {
    if (popoverOpen && !wrapper.contains(e.target)) closePopover();
  }
  document.addEventListener('click', onDocumentClick, true);

  // Keyboard: Esc closes
  function onKeydown(e) {
    if (e.key === 'Escape' && popoverOpen) closePopover();
  }
  document.addEventListener('keydown', onKeydown);

  // Apply persisted theme on mount
  applyTheme(current);

  function update(_snapshot) { /* no-op */ }

  function destroy() {
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeydown);
    wrapper.remove();
  }

  return { update, destroy };
}
