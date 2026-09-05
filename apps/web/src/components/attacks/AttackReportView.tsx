// apps/web/src/components/attacks/AttackReportView.tsx  (FIXED — full reprint)
import type { AttackReport } from '@acsf/shared';
import { Badge, decisionTone } from '../ui/Badge';
import { Card } from '../ui/Card';

export function AttackReportView({ report }: { report: AttackReport }) {
  return (
    <Card
      title={`Attack Result — ${report.title}`}
      subtitle={`executed ${report.executedAt}`}
      right={
        <div className="flex items-center gap-2">
          {report.drift !== null ? (
            <span className="font-mono text-[11px] text-ink-soft">drift {report.drift.toFixed(2)}</span>
          ) : null}
          <Badge tone={decisionTone(report.decision)}>{report.decision}</Badge>
        </div>
      }
    >
      <div className="space-y-3">
        {report.violatedRule !== null ? (
          <p className="rounded-xl border border-block/25 bg-block/10 px-3 py-2 font-mono text-xs text-block">
            RULE VIOLATED — {report.violatedRule}
          </p>
        ) : null}
        <ol className="space-y-1.5">
          {report.steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-xs">
              <span className="font-mono text-ink-faint">{i + 1}.</span>
              <span>
                <span className="font-medium text-ink">{step.label}</span>
                <span className="text-ink-soft"> — {step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="font-mono text-[10px] text-ink-faint">
          decision {report.decisionId ?? '—'} · payment {report.paymentId ?? '—'} · audit event{' '}
          {report.auditEventId ?? 'recorded'}
        </p>
        <p className="text-[10px] text-ink-faint">
          Every attack executed real application logic through the firewall — no simulated outcomes.
        </p>
      </div>
    </Card>
  );
}
