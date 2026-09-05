// apps/web/src/components/attacks/AdversarialPanel.tsx
import { useState } from 'react';
import { errMessage } from '../../api/client';
import { useAdversarialRun } from '../../hooks';
import { timeOf } from '../../lib/format';
import { Badge, decisionTone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

export function AdversarialPanel() {
  const run = useAdversarialRun();
  const report = run.data ?? null;
  const [executedAt, setExecutedAt] = useState<string | null>(null);
  return (
    <Card
      title="Adversarial Agent"
      subtitle="A deterministic red-team agent submits ten attack classes through the normal gateway"
      right={
        report !== null ? (
          <span className="font-mono text-[11px] text-ink-soft">
            {report.counts.allow}A / {report.counts.block}B / {report.counts.reauthorize}R / {report.counts.humanApproval}H
          </span>
        ) : null
      }
    >
      <Button variant="danger" loading={run.isPending} onClick={() => run.mutate(undefined, { onSuccess: () => setExecutedAt(new Date().toISOString()) })}>
        Launch Adversarial Agent
      </Button>
      {run.error !== null ? <p className="mt-3 text-xs text-block">{errMessage(run.error)}</p> : null}
      {report !== null ? (
        <div className="mt-3 max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-[10px] uppercase tracking-widest text-ink-faint">
                <th className="pb-2 pr-3">attack</th>
                <th className="pb-2 pr-3">action</th>
                <th className="pb-2 pr-3">decision</th>
                <th className="pb-2">violations</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((step, i) => (
                <tr key={i} className="border-t border-ink-line/70 align-top">
                  <td className="py-1.5 pr-3 text-ink" title={step.note}>
                    {step.attack}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-[10px] text-ink-faint">{step.action}</td>
                  <td className="py-1.5 pr-3">
                    {step.decision !== null ? (
                      <Badge tone={decisionTone(step.decision)}>{step.decision}</Badge>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="py-1.5 font-mono text-[10px] text-ink-faint">
                    {step.violationCodes.join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 font-mono text-[10px] text-ink-faint">
            {/* Was new Date() at RENDER time, so the label was fabricated and
                changed on every re-render. AdversarialReport carries no
                timestamp, so record when the run actually returned. */}
            {report.agentId} · final {report.finalState}
            {executedAt !== null ? ` · executed ${timeOf(executedAt)}` : ''}
          </p>
        </div>
      ) : null}
    </Card>
  );
}