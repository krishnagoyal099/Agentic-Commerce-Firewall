// apps/web/src/components/growth/GrowthPanel.tsx
import { formatINR, type GrowthAgentReport, type GrowthOpportunityDTO, type GrowthStats } from '@acsf/shared';
import { Badge, decisionTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { StatCard } from '../ui/StatCard';

export function GrowthPanel({
  analytics,
  opportunities,
  onPropose,
  proposing,
  report,
  error,
}: {
  analytics: GrowthStats[];
  opportunities: GrowthOpportunityDTO[];
  onPropose: () => void;
  proposing: boolean;
  report: GrowthAgentReport | null;
  error: string | null;
}) {
  const top = analytics[0] ?? null;
  const latest = opportunities.length > 0 ? opportunities[opportunities.length - 1] ?? null : null;

  return (
    <div className="space-y-6">
      <div className="hero-grid panel-dark rounded-[28px] bg-brand-500 p-6 shadow-panel sm:p-7">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.3em] text-brand-100">REVENUE OPPORTUNITY</p>
        {top !== null ? (
          <>
            <div className="display mt-4 flex flex-wrap items-center gap-3 text-3xl text-white sm:text-4xl">
              <span className="font-light">{top.productNameA}</span>
              <span className="text-brand-200">→</span>
              <span className="font-extrabold">{top.productNameB}</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard onDark label="Co-purchase rate" value={`${Math.round(top.coPurchaseRate * 100)}%`} />
              <StatCard onDark label="Average upsell" value={formatINR(top.avgUpsellPaise)} />
              <StatCard onDark label="Margin" value={`${top.marginPercent}%`} />
              <StatCard onDark label="Conversions" value={top.conversionCount} />
              <StatCard onDark label="Revenue contribution" value={formatINR(top.revenueContributionPaise)} />
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-brand-100">
            No completed transactions yet — run START DEMO to generate real history.
          </p>
        )}
        {top !== null ? (
          <p className="mt-4 max-w-3xl text-xs leading-relaxed text-brand-100">
            Anchored on <span className="font-semibold text-white">{top.productNameA}</span> — the
            best-selling product in the order history this demo run generated, not a fixed choice.
            The history follows the intent you ran on the Overview tab; if a product you asked for
            costs more than the merchant&apos;s per-order cap, it cannot be sold at all, and the
            closest product the policy does allow anchors the history instead.
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="onDark">GROWTH AGENT PROPOSED</Badge>
          <span className="text-brand-200">→</span>
          <Badge
            tone={
              latest?.decision === 'ALLOW' ? 'allow' : latest?.decision === 'BLOCK' ? 'block' : 'review'
            }
          >
            FIREWALL {latest?.status ?? 'AWAITING PROPOSAL'}
          </Badge>
          {latest?.decision != null ? <Badge tone={decisionTone(latest.decision)}>{latest.decision}</Badge> : null}
          <span className="ml-auto">
            <Button variant="onDark" onClick={onPropose} loading={proposing}>
              Growth agent proposes
            </Button>
          </span>
        </div>
        {error !== null ? (
          <p className="mt-3 inline-block rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-white">{error}</p>
        ) : null}
        {report !== null ? (
          <div className="mt-4 rounded-2xl bg-white/10 p-3 text-xs ring-1 ring-inset ring-white/15">
            <div className="flex items-center gap-2">
              <Badge tone={decisionTone(report.decision ?? 'BLOCK')}>{report.decision ?? '—'}</Badge>
              <span className="text-white">{report.note}</span>
            </div>
            {report.opportunity !== null ? (
              <p className="mt-1 font-mono text-[10px] text-brand-100">
                opportunity {report.opportunity.id} · {report.opportunity.status} · applied={String(report.applied)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Card title="Growth Analytics" subtitle="Computed from completed orders — co-purchase pairs ranked">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-ink-faint">
                <th className="pb-2 pr-4">pair</th>
                <th className="pb-2 pr-4">co-purchase</th>
                <th className="pb-2 pr-4">avg upsell</th>
                <th className="pb-2 pr-4">margin</th>
                <th className="pb-2 pr-4">conversions</th>
                <th className="pb-2">revenue</th>
              </tr>
            </thead>
            <tbody>
              {analytics.map((row) => (
                <tr key={row.productIdB} className="border-t border-ink-line/70">
                  <td className="py-2 pr-4 text-ink">
                    {row.productNameA} <span className="text-brand-600">→</span> {row.productNameB}
                  </td>
                  <td className="py-2 pr-4 font-mono text-ink-soft">{Math.round(row.coPurchaseRate * 100)}%</td>
                  <td className="py-2 pr-4 font-mono text-ink-soft">{formatINR(row.avgUpsellPaise)}</td>
                  <td className="py-2 pr-4 font-mono text-ink-soft">{row.marginPercent}%</td>
                  <td className="py-2 pr-4 font-mono text-ink-soft">{row.conversionCount}</td>
                  <td className="py-2 font-mono text-ink-soft">{formatINR(row.revenueContributionPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {analytics.length === 0 ? <p className="py-3 text-xs text-ink-faint">No analytics yet.</p> : null}
        </div>
      </Card>

      <Card title="Growth Opportunities" subtitle="Every proposal is persisted, firewall-evaluated, and auditable">
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {opportunities.length === 0 ? (
            <p className="text-xs text-ink-faint">No opportunities proposed yet.</p>
          ) : (
            opportunities.map((opp) => (
              <div
                key={opp.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-line bg-canvas-mist px-3 py-2 text-xs"
              >
                <Badge tone={opp.status === 'ALLOWED' || opp.status === 'CONVERTED' ? 'allow' : opp.status === 'BLOCKED' ? 'block' : 'review'}>
                  {opp.status}
                </Badge>
                <span className="text-ink">{opp.reason}</span>
                <span className="font-mono text-[10px] text-ink-faint">
                  {opp.productId} on {opp.anchorProductId} · {formatINR(opp.amountPaise)}
                </span>
                {opp.decision !== null ? <Badge tone={decisionTone(opp.decision)}>{opp.decision}</Badge> : null}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}