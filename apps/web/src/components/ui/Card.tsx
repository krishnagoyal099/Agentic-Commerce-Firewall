// apps/web/src/components/ui/Card.tsx
import type { ReactNode } from 'react';

export type CardTone = 'light' | 'dark';

export function Card({
  title,
  subtitle,
  right,
  tone = 'light',
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  tone?: CardTone;
  children: ReactNode;
  className?: string;
}) {
  const dark = tone === 'dark';
  return (
    <section
      className={`overflow-hidden rounded-3xl ${
        dark
          ? 'panel-dark bg-brand-500 text-white shadow-panel'
          : 'border border-ink-line bg-white shadow-card'
      } ${className}`}
    >
      {title !== undefined || right !== undefined ? (
        <header
          className={`flex items-start justify-between gap-4 px-5 py-4 ${
            dark ? 'border-b border-white/15' : 'border-b border-ink-line'
          }`}
        >
          <div className="min-w-0">
            {title !== undefined ? (
              <h2
                className={`text-[13px] font-bold tracking-tight ${dark ? 'text-white' : 'text-ink'}`}
              >
                {title}
              </h2>
            ) : null}
            {subtitle !== undefined ? (
              <p className={`mt-1 text-xs ${dark ? 'text-brand-100' : 'text-ink-soft'}`}>{subtitle}</p>
            ) : null}
          </div>
          {right}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}
