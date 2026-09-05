// apps/web/src/components/protocol/ProtocolDemoView.tsx
import type { Decision } from '@acsf/shared';
import type { ProtocolDemoReport } from '../../types';
import { timeOf } from '../../lib/format';
import { Badge, decisionTone } from '../ui/Badge';
import { Card } from '../ui/Card';

export function ProtocolDemoView({ report }: { report: ProtocolDemoReport }) {
  return (
    <Card
      title="Protocol Demo"
      subtitle={`run ${report.runId} · mandate ${report.mandateId}`}
      right={<Badge tone="accent">{report.finalState}</Badge>}
    >
      <ol className="space-y-2">
        {report.steps.map((step) => (
          <li key={step.step} className="rounded-xl border border-ink-line bg-canvas-mist px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-ink-faint">{String(step.step).padStart(2, '0')}</span>
              <span className="text-ink">{step.title}</span>
              {step.decision !== null ? (
                <Badge tone={decisionTone(step.decision)}>{step.decision}</Badge>
              ) : null}
              <span className="ml-auto font-mono text-[10px] text-ink-faint">
                {step.protocolRequestId !== null ? `req ${step.protocolRequestId}` : ''}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-soft">{step.summary}</p>
            <p className="font-mono text-[10px] text-ink-faint">tool: {step.tool}</p>
          </li>
        ))}
      </ol>
      {report.receiptText !== null ? (
        <details className="mt-3 overflow-hidden rounded-2xl border border-ink-line bg-canvas-mist">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-brand-600">Audit receipt</summary>
          <pre className="mx-3 mb-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-ink p-3 font-mono text-[11px] leading-relaxed text-canvas-soft">
            {report.receiptText}
          </pre>
        </details>
      ) : null}
      <p className="mt-2 font-mono text-[10px] text-ink-faint">
        finished {timeOf(report.finishedAt)} · cart {report.cartId ?? '—'} · payment {report.paymentId ?? '—'} · order{' '}
        {report.orderId ?? '—'}
      </p>
    </Card>
  );
}