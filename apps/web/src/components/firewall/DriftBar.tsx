// apps/web/src/components/firewall/DriftBar.tsx
export function DriftBar({ label, value }: { label: string; value: number }) {
  const tone = value > 0.9 ? 'bg-block' : value > 0.7 ? 'bg-review' : 'bg-brand-500';
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-[11px] text-ink-soft">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-brand-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
      <span className="w-9 text-right font-mono text-[11px] text-ink-soft">{value.toFixed(2)}</span>
    </div>
  );
}