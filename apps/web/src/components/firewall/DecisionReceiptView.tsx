// apps/web/src/components/firewall/DecisionReceiptView.tsx
import { renderReceipt, type DecisionReceipt } from '@acsf/shared';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { DriftBar } from './DriftBar';

export function DecisionReceiptView({
  receipt,
  rendered,
  approving,
  reviewedAt,
  approvalError,
  onApprove,
}: {
  receipt: DecisionReceipt | null;
  rendered: string | null;
  approving: boolean;
  /** decision.approvedAt — recordHumanApproval never rewrites receipt.decision. */
  reviewedAt: string | null;
  approvalError: string | null;
  onApprove: (outcome: 'approved' | 'rejected') => void;
}) {
  if (receipt === null || rendered === null) {
    return (
      <Card title="Decision Receipt">
        <p className="text-xs text-ink-faint">Select a decision to inspect its receipt.</p>
      </Card>
    );
  }
  // recordHumanApproval sets decision.approvedAt but leaves the persisted
  // receipt untouched, so receipt.decision alone kept the buttons live after a
  // successful approval — clicking again just returned DECISION_ALREADY_APPROVED
  // into a void.
  const needsApproval = receipt.decision === 'HUMAN_APPROVAL' && reviewedAt === null;
  const alreadyReviewed = receipt.decision === 'HUMAN_APPROVAL' && reviewedAt !== null;
  return (
    <Card
      title="Decision Receipt"
      subtitle={`${receipt.actionId} · ${receipt.protocol}`}
      right={<Badge tone={receipt.decision === 'ALLOW' ? 'allow' : receipt.decision === 'BLOCK' ? 'block' : 'review'}>{receipt.decision}</Badge>}
    >
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl bg-ink p-4 font-mono text-[11px] leading-relaxed text-canvas-soft">
        {rendered}
      </pre>
      {receipt.drift !== null ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-ink-faint">Authority Drift</p>
          <DriftBar label="Monetary" value={receipt.drift.monetary} />
          <DriftBar label="Category" value={receipt.drift.category} />
          <DriftBar label="Discount" value={receipt.drift.discount} />
          <DriftBar label="Temporal" value={receipt.drift.temporal} />
          <DriftBar label="Action" value={receipt.drift.action} />
          <DriftBar label="OVERALL" value={receipt.drift.overall} />
        </div>
      ) : null}
      {alreadyReviewed ? (
        <div className="mt-4 rounded-xl border border-allow/25 bg-allow/10 p-3">
          <p className="text-xs text-allow">
            APPROVED by a human at {reviewedAt} — execution is now permitted for this decision. A
            review is final and cannot be revisited.
          </p>
        </div>
      ) : null}
      {needsApproval ? (
        <div className="mt-4 rounded-xl border border-review/25 bg-review/10 p-3">
          <p className="text-xs text-review">
            HUMAN APPROVAL REQUIRED — an agent can never approve its own request.
          </p>
          {approvalError !== null ? (
            <p className="mt-2 text-xs text-block">{approvalError}</p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button variant="primary" loading={approving} onClick={() => onApprove('approved')}>
              Approve as demo-user
            </Button>
            <Button variant="danger" loading={approving} onClick={() => onApprove('rejected')}>
              Reject
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export { renderReceipt };