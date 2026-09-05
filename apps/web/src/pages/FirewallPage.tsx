// apps/web/src/pages/FirewallPage.tsx  (FULL FINAL)
import { useEffect, useState } from 'react';
import type { Decision, DecisionSummaryDTO } from '@acsf/shared';
import { errMessage } from '../api/client';
import { AuthorityMap } from '../components/firewall/AuthorityMap';
import { CounterfactualPanel } from '../components/firewall/CounterfactualPanel';
import { DecisionList } from '../components/firewall/DecisionList';
import { DecisionReceiptView } from '../components/firewall/DecisionReceiptView';
import { DriftGraph } from '../components/firewall/DriftGraph';
import {
  useAgents,
  useApprove,
  useDecisionDetail,
  useDecisions,
  usePolicy,
} from '../hooks';

export function FirewallPage() {
  const [filter, setFilter] = useState<Decision | 'ALL'>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const decisions = useDecisions(filter === 'ALL' ? undefined : filter);
  const detail = useDecisionDetail(selectedId);
  const approve = useApprove();
  const agents = useAgents();
  const policy = usePolicy();

  useEffect(() => {
    const rows = decisions.data?.decisions ?? [];
    // Also re-selects when the current id has vanished (e.g. a demo reset from
    // another tab wiped every decision), which previously stuck the pane on a
    // permanent DECISION_NOT_FOUND.
    if (rows.length > 0 && (selectedId === null || !rows.some((row: DecisionSummaryDTO) => row.id === selectedId))) {
      setSelectedId(rows[0]?.id ?? null);
    }
  }, [decisions.data, selectedId]);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="space-y-3">
          <DecisionList
            decisions={decisions.data?.decisions ?? []}
            selectedId={selectedId}
            filter={filter}
            onFilter={(next) => {
              setFilter(next);
              setSelectedId(null);
            }}
            onSelect={setSelectedId}
            loading={decisions.isPending}
          />
          {decisions.error !== null ? <p className="text-xs text-block">{errMessage(decisions.error)}</p> : null}
        </div>
        <div className="space-y-6">
          {detail.error !== null ? <p className="text-xs text-block">{errMessage(detail.error)}</p> : null}
          <DecisionReceiptView
            receipt={detail.data?.decision.receipt ?? null}
            rendered={detail.data?.rendered ?? null}
            approving={approve.isPending}
            reviewedAt={detail.data?.decision.approvedAt ?? null}
            approvalError={approve.error !== null ? errMessage(approve.error) : null}
            onApprove={(outcome) => {
              if (selectedId !== null) {
                approve.reset();
                approve.mutate({ decisionId: selectedId, approvedBy: 'demo-user', outcome });
              }
            }}
          />
          <DriftGraph sessionId={detail.data?.decision.sessionId ?? null} />
        </div>
      </div>
      <CounterfactualPanel />
      <AuthorityMap policy={policy.data?.active ?? null} agents={agents.data?.agents ?? []} />
    </div>
  );
}