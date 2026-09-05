// apps/web/src/components/layout/AppShell.tsx
import { Outlet } from 'react-router-dom';
import { formatINR } from '@acsf/shared';
import { useMetrics } from '../../hooks';
import { Nav } from './Nav';

function Chip({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'allow' | 'block' }) {
  const toneClass = tone === 'allow' ? 'text-allow' : tone === 'block' ? 'text-block' : 'text-ink';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-line bg-white px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-faint">{label}</span>
      <span className={`font-mono text-[11px] font-bold ${toneClass}`}>{value}</span>
    </span>
  );
}

export function AppShell() {
  const metrics = useMetrics();
  const m = metrics.data;
  return (
    <div className="canvas-grid min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1560px] px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="Agentic Commerce Firewall"
              className="h-11 w-11 shrink-0 rounded-2xl object-cover shadow-lift"
            />
            <div className="leading-tight">
              <p className="text-[15px] font-extrabold tracking-tightest text-ink">
                Agentic Commerce Firewall
              </p>
              <p className="text-[11px] font-medium text-ink-soft">
                Bounded autonomy for autonomous commerce
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip label="Revenue" value={m ? formatINR(m.revenueGeneratedPaise) : '—'} />
            <Chip label="Blocked" value={m ? String(m.blockedActions) : '—'} tone="block" />
            <Chip
              label="Chain"
              value={m ? (m.auditChain.valid ? 'valid' : 'BROKEN') : '—'}
              tone={m ? (m.auditChain.valid ? 'allow' : 'block') : 'ink'}
            />
          </div>
        </header>

        <div className="mt-5">
          <Nav />
        </div>

        <main className="mt-4 min-w-0">
          <Outlet />
        </main>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-ink-line/70 pt-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
          <span>AI proposes · Policy decides</span>
          <span>Only authorized actions reach money</span>
        </footer>
      </div>
    </div>
  );
}
