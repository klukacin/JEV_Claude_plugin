// lib/util.mjs — tiny helpers shared by hooks, server, and scripts.

export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function truncate(text, max) {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function preview(text, max = 120) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}
