// public/lib/format.js — shared formatters
export function formatTokens(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(0) + 'k';
  return Math.round(n).toString();
}

export function formatX(x) {
  if (x == null) return '—';
  return x.toFixed(2) + '×';
}

