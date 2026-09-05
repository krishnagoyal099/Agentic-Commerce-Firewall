// apps/web/src/components/firewall/DecisionList.tsx
import type { Decision, DecisionSummaryDTO } from '@acsf/shared';
import { timeOf } from '../../lib/format';
import { Badge, decisionTone } from '../ui/Badge';
import { Button } from '../ui/Button';

const FILTERS: Array<Decision | 'ALL'> = ['ALL', 'ALLOW', 'HUMAN_APPROVAL', 'REAUTHORIZE', 'BLOCK'];

export function DecisionList({
  decisions,
  selectedId,
  filter,
  onFilter,
  onSelect,
  loading,
}: {
  decisions: DecisionSummaryDTO[];
  selectedId: string | null;
  filter: Decision | 'ALL';
  onFilter: (filter: Decision | 'ALL') => void;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-ink-line bg-white shadow-card">
      <div className="flex flex-wrap gap-1 border-b border-ink-line/70 p-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onFilter(f)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors ${
              filter === f ? 'bg-brand-500 text-ink shadow-lift' : 'text-ink-faint hover:bg-brand-50 hover:text-ink'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="max-h-[560px] min-h-0 overflow-y-auto">
        {loading ? (
          <p className="p-4 text-xs text-ink-faint">Loading decisions…</p>
        ) : decisions.length === 0 ? (
          <p className="p-4 text-xs text-ink-faint">No decisions yet — run START DEMO.</p>
        ) : (
          decisions.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelect(d.id)}
              className={`block w-full border-b border-ink-line/70 px-3 py-2 text-left transition-colors ${
                selectedId === d.id ? 'bg-brand-50 ring-1 ring-inset ring-brand-200' : 'hover:bg-canvas-mist'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <Badge tone={decisionTone(d.decision)}>{d.decision}</Badge>
                <span className="font-mono text-[10px] text-ink-faint">{timeOf(d.createdAt)}</span>
              </div>
              <p className="mt-1 truncate text-xs text-ink">{d.actionSummary}</p>
              <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
                {d.agentId} · drift {d.driftOverall !== null ? d.driftOverall.toFixed(2) : '—'}
              </p>
            </button>
          ))
        )}
      </div>
      <div className="border-t border-ink-line/70 p-2 text-center">
        <span className="text-[10px] text-ink-faint">{decisions.length} shown</span>
      </div>
    </div>
  );
}