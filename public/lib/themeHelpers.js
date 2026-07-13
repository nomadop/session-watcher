// Pure theme logic — no DOM dependencies. Shared by themeChip.js and tests.
export const THEMES = [
  { id: 'c', label: 'C', colors: ['#4fe0b0', '#ffc24d', '#ff7566'] },
  { id: 'd', label: 'D', colors: ['#6cc6f0', '#4fe0b0', '#ffc24d'] },
  { id: 'f', label: 'F', colors: ['#a78bfa', '#f472b6', '#fb923c'] },
  { id: 'g', label: 'G', colors: ['#34d399', '#fbbf24', '#f87171'] },
  { id: 'h', label: 'H', colors: ['#4fe0b0', '#ffc24d', '#93a1ab'] },
];

export const VALID_IDS = THEMES.map(t => t.id);
export const STORAGE_KEY = 'session-watcher.theme';

export function resolveTheme(stored) {
  return (stored && VALID_IDS.includes(stored)) ? stored : 'h';
}

export function dotGradient(colors) {
  return `conic-gradient(${colors.map((c, i) => `${c} ${i * (360 / colors.length)}deg ${(i + 1) * (360 / colors.length)}deg`).join(', ')})`;
}
