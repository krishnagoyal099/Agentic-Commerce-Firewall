// apps/web/src/components/dashboard/DemoResultView.tsx
import { formatINR, type DemoStartReport } from '@acsf/shared';
import { Badge, decisionTone, paymentTone } from '../ui/Badge';
import { Card } from '../ui/Card';

export function DemoResultView({ report }: { report: DemoStartReport }) {
  const plan = report.reset.plan;
  const intent = plan.intent;

  return (
    <Card
      title="Demo Run"
      subtitle={`history regenerated (${report.reset.historyOrders} orders) · mandate ${report.reset.mandateId}`}
      right={<Badge tone="accent">{report.finalState}</Badge>}
    >
      <div className="space-y-4 text-sm">
        <blockquote className="rounded-r-xl border-l-4 border-brand-400 bg-canvas-mist py-2 pl-4 pr-3 text-ink-soft">
          <span className="text-[10px] font-bold uppercase tracking-widest text-ink-faint">USER INTENT</span>
          <p className="mt-1 italic">&ldquo;{intent}&rdquo;</p>
          <p className="mt-2 flex flex-wrap items-center gap-1.5 not-italic">
            <Badge tone="accent">
              {plan.source === 'llm' ? 'parsed by LLM' : 'parsed by keywords'}
            </Badge>
            <Badge tone="neutral">ceiling ₹{plan.maxAmountRupees.toLocaleString('en-IN')}</Badge>
            {plan.allowedCategories.map((category) => (
              <Badge key={category} tone="neutral" mono>
                {category}
              </Badge>
            ))}
            <Badge tone="neutral">{plan.ttlHours}h</Badge>
          </p>
        </blockquote>

        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-ink-faint">Buyer agent</p>
          <ol className="space-y-1 text-xs text-ink-soft">
            {report.buyer.steps.map((step) => (
              <li key={step.n} className="flex items-start gap-2">
                <span className="mt-0.5 font-mono text-ink-faint">{step.n}.</span>
                <span>
                  {step.summary}{' '}
                  {step.decision !== null ? <Badge tone={decisionTone(step.decision)}>{step.decision}</Badge> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-2xl border border-ink-line bg-canvas-mist p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-bold uppercase tracking-widest text-ink-faint">Growth</span>
            {report.growth.opportunity !== null ? (
              <>
                <span className="font-semibold text-ink">
                  {report.growth.opportunity.stats?.productNameA ?? '—'} →{' '}
                  {report.growth.opportunity.stats?.productNameB ?? report.growth.opportunity.productId}
                </span>
                <Badge tone="accent">
                  co-purchase {Math.round((report.growth.opportunity.stats?.coPurchaseRate ?? 0) * 100)}%
                </Badge>
                <Badge tone="accent">upsell {formatINR(report.growth.opportunity.amountPaise)}</Badge>
                <Badge tone="accent">margin {report.growth.opportunity.stats?.marginPercent ?? 0}%</Badge>
                <Badge tone={decisionTone(report.growth.decision ?? 'BLOCK')}>
                  FIREWALL {report.growth.decision ?? '—'}
                </Badge>
                <Badge tone="neutral">{report.growth.opportunity.status}</Badge>
              </>
            ) : (
              <span className="text-ink-faint">{report.growth.note}</span>
            )}
          </div>
        </div>

        {report.purchase !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-bold uppercase tracking-widest text-ink-faint">Payment</span>
            <span className="font-semibold text-ink">{formatINR(report.purchase.payment?.amountPaise ?? 0)}</span>
            <Badge tone={paymentTone(report.purchase.payment?.state ?? '')}>
              {report.purchase.payment?.state ?? '—'}
            </Badge>
            <span className="text-ink-faint">
              order {report.purchase.order?.id ?? '—'} · {report.purchase.order?.status ?? '—'}
            </span>
          </div>
        ) : null}

        <p className="font-mono text-[11px] text-ink-faint">
          {report.auditChain.message} · history anchored on {report.reset.history.anchorProductId}
          {report.reset.history.companionProductId !== null
            ? ` + ${report.reset.history.companionProductId}`
            : ''}
          {report.reset.history.adaptive ? ' (adapted to your intent)' : ''}
        </p>

        {report.receiptText !== null ? (
          <details className="overflow-hidden rounded-2xl border border-ink-line bg-canvas-mist">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-brand-600">
              Why was this allowed? — decision receipt
            </summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap mx-3 mb-3 rounded-xl bg-ink p-3 font-mono text-[11px] leading-relaxed text-canvas-soft">
              {report.receiptText}
            </pre>
          </details>
        ) : null}
      </div>
    </Card>
  );
}