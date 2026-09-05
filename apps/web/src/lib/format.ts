// apps/web/src/lib/format.ts
export function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString('en-GB', { hour12: false });
}

export function shortHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined || hash.length === 0) return '—';
  return `${hash.slice(0, 10)}…`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}