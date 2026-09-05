// apps/web/src/components/payments/PaymentTimeline.tsx
import { formatINR, type PaymentDTO } from '@acsf/shared';
import { timeOf } from '../../lib/format';
import { Badge, paymentTone } from '../ui/Badge';
import { Card } from '../ui/Card';

export function PaymentTimeline({ payment }: { payment: PaymentDTO }) {
  return (
    <Card
      title="Payment"
      subtitle={`${payment.id} · ${payment.provider} · agent ${payment.agentId}`}
      right={
        <div className="flex items-center gap-2">
          <Badge tone={paymentTone(payment.state)}>{payment.state}</Badge>
          {payment.duplicate ? <Badge tone="review">DUPLICATE</Badge> : null}
          {payment.reconciled ? <Badge tone="accent">RECONCILED</Badge> : null}
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-ink-soft md:grid-cols-4">
        <span>amount {formatINR(payment.amountPaise)}</span>
        <span>provider id {payment.providerPaymentId ?? '—'}</span>
        <span>idem key {payment.idempotencyKey}</span>
        <span>order {payment.orderId ?? '—'}</span>
      </div>
      <ol className="mt-3 max-h-72 space-y-1.5 overflow-y-auto">
        {payment.timeline.map((event, i) => (
          <li key={i} className="rounded-xl border border-ink-line bg-canvas-mist px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="font-mono text-ink-faint">{timeOf(event.at)}</span>
              <span className="font-mono text-ink">{event.event}</span>
              {event.state !== null ? <Badge tone={paymentTone(event.state)}>{event.state}</Badge> : null}
              {event.duplicate ? <Badge tone="review">DUPLICATE</Badge> : null}
              {event.ignored ? <Badge tone="neutral">IGNORED</Badge> : null}
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">{event.detail}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}