// apps/web/src/components/dashboard/AgenticFlowPanel.tsx
import { formatINR, type MetricsSnapshot } from '@acsf/shared';
import { Card } from '../ui/Card';

const FLOW = [
  { label: 'AI BUYER AGENT', metric: (m: MetricsSnapshot) => `${m.autonomousActions} autonomous actions` },
  { label: 'PROTOCOL INGRESS (MCP)', metric: (m: MetricsSnapshot) => `${m.protocolTransactions} protocol transactions` },
  { label: 'AGENTIC FIREWALL', metric: (m: MetricsSnapshot) => `${m.blockedActions} blocked · drift avg ${m.averageAuthorityDrift.toFixed(2)}` },
  { label: 'PAYMENT (guarded)', metric: (m: MetricsSnapshot) => `${formatINR(m.revenueGeneratedPaise)} captured · ${m.duplicatePaymentsPrevented} dupes prevented` },
] as const;

export function AgenticFlowPanel({ snapshot }: { snapshot: MetricsSnapshot | null }) {
  return (
    <Card title="Agentic Commerce Panel" subtitle="Every arrow passes through the deterministic firewall">
      <ol className="space-y-0">
        {FLOW.map((node, i) => {
          const firewall = node.label === 'AGENTIC FIREWALL';
          return (
            <li key={node.label} className="relative">
              <div
                className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3 ${
                  firewall
                    ? 'bg-brand-500 text-white shadow-lift'
                    : 'border border-ink-line bg-canvas-mist'
                }`}
              >
                <span
                  className={`flex items-center gap-2.5 font-mono text-xs font-bold tracking-wide ${
                    firewall ? 'text-white' : 'text-ink'
                  }`}
                >
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${
                      firewall ? 'bg-white/20 text-white' : 'bg-brand-100 text-brand-700'
                    }`}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {node.label}
                </span>
                <span className={`text-[11px] font-medium ${firewall ? 'text-brand-100' : 'text-ink-soft'}`}>
                  {snapshot !== null ? node.metric(snapshot) : '—'}
                </span>
              </div>
              {i < FLOW.length - 1 ? <div className="ml-8 h-3 w-0.5 bg-brand-200" /> : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
