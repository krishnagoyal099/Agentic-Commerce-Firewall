// apps/web/src/components/dashboard/MetricsGrid.tsx
import { formatINR, type MetricsSnapshot } from '@acsf/shared';
import { Badge } from '../ui/Badge';
import { StatCard } from '../ui/StatCard';

export function MetricsGrid({ snapshot }: { snapshot: MetricsSnapshot }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <div className="rounded-2xl bg-brand-500 px-4 py-3 shadow-panel">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-brand-100">
            Revenue Generated
          </p>
          <p className="mt-1 text-2xl font-extrabold tracking-tightest text-white">
            {formatINR(snapshot.revenueGeneratedPaise)}
          </p>
          <p className="mt-0.5 text-[11px] text-brand-100">captured through the firewall</p>
        </div>
        <StatCard label="Autonomous Actions" value={snapshot.autonomousActions} />
        <StatCard label="Blocked Actions" value={snapshot.blockedActions} tone="block" />
        <StatCard label="Human Approvals" value={snapshot.humanApprovals} tone="review" />
        <StatCard label="Reauthorizations" value={snapshot.reauthorizations} tone="review" />
        <StatCard label="Duplicate Payments Prevented" value={snapshot.duplicatePaymentsPrevented} />
        <StatCard
          label="Current Daily Budget"
          value={formatINR(snapshot.currentDailyBudgetPaise)}
          sub={`of ${formatINR(snapshot.dailyBudgetLimitPaise)}`}
        />
        <StatCard label="Average Authority Drift" value={snapshot.averageAuthorityDrift.toFixed(2)} />
        <StatCard label="Fuzz Cases Tested" value={snapshot.fuzzCasesTested.toLocaleString('en-IN')} />
        <StatCard
          label="Policy Bypasses"
          value={snapshot.policyBypasses}
          tone={snapshot.policyBypasses > 0 ? 'block' : 'allow'}
          sub={snapshot.policyBypasses > 0 ? 'investigate immediately' : 'no bypasses detected'}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ink-line bg-white px-4 py-3 text-xs shadow-card">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ink-faint">Decisions</span>
        <Badge tone="allow">ALLOW {snapshot.decisionCounts.ALLOW}</Badge>
        <Badge tone="review">HUMAN_APPROVAL {snapshot.decisionCounts.HUMAN_APPROVAL}</Badge>
        <Badge tone="review">REAUTHORIZE {snapshot.decisionCounts.REAUTHORIZE}</Badge>
        <Badge tone="block">BLOCK {snapshot.decisionCounts.BLOCK}</Badge>
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {snapshot.auditChain.message} · protocol txns {snapshot.protocolTransactions}
        </span>
      </div>
    </div>
  );
}
