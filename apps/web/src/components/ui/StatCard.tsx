// apps/web/src/components/ui/StatCard.tsx
import type { ReactNode } from 'react';

type Tone = 'neutral' | 'allow' | 'review' | 'block' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'text-ink',
  allow: 'text-allow',
  review: 'text-review',
  block: 'text-block',
  accent: 'text-brand-500',
};

const DARK_TONES: Record<Tone, string> = {
  neutral: 'text-white',
  allow: 'text-white',
  review: 'text-white',
  block: 'text-white',
  accent: 'text-white',
};

export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
  onDark = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  onDark?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl px-4 py-3 ${
        onDark ? 'bg-white/10 ring-1 ring-inset ring-white/15' : 'border border-ink-line bg-white shadow-card'
      }`}
    >
      <p
        className={`text-[10px] font-semibold uppercase tracking-widest ${
          onDark ? 'text-brand-100' : 'text-ink-faint'
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-extrabold tracking-tightest ${
          onDark ? DARK_TONES[tone] : TONES[tone]
        }`}
      >
        {value}
      </p>
      {sub !== undefined ? (
        <p className={`mt-0.5 text-[11px] ${onDark ? 'text-brand-100' : 'text-ink-faint'}`}>{sub}</p>
      ) : null}
    </div>
  );
}
