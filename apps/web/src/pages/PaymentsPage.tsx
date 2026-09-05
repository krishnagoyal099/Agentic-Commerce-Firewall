// apps/web/src/pages/PaymentsPage.tsx
import { useEffect, useState } from 'react';
import type { ReconciliationReportDTO } from '@acsf/shared';
import { errMessage } from '../api/client';
import { PaymentTimeline } from '../components/payments/PaymentTimeline';
import { ProviderEventForm } from '../components/payments/ProviderEventForm';
import { Badge, paymentTone, resolutionTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { timeOf } from '../lib/format';
import { usePayments, useProviderEvent, useReconcile } from '../hooks';
import type { ProviderEventResult } from '../types';

export function PaymentsPage() {
  const payments = usePayments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reconcile = useReconcile();
  const providerEvent = useProviderEvent();

  useEffect(() => {
    const list = payments.data?.payments ?? [];
    // Also re-selects when the current id has vanished (a demo reset from
    // another tab deletes every payment), which previously stuck the pane on
    // "Select a payment." with no way back.
    if (list.length > 0 && (selectedId === null || !list.some((p) => p.id === selectedId))) {
      setSelectedId(list[0]?.id ?? null);
    }
  }, [payments.data, selectedId]);

  const rows = payments.data?.payments ?? [];
  const selected = rows.find((p) => p.id === selectedId) ?? null;
  // Keyed by payment id. These used to be bare results, so selecting another
  // row while a reconcile or provider event was in flight rendered the first
  // payment's outcome inside the second payment's detail pane.
  const [reconcileFor, setReconcileFor] = useState<{ paymentId: string; report: ReconciliationReportDTO } | null>(null);
  const [eventFor, setEventFor] = useState<{ paymentId: string; result: ProviderEventResult } | null>(null);
  const reconcileResult = reconcileFor !== null && reconcileFor.paymentId === selectedId ? reconcileFor.report : null;
  const eventResult = eventFor !== null && eventFor.paymentId === selectedId ? eventFor.result : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <Card title="Payments" subtitle={`${rows.length} recent`}>
        <div className="max-h-[640px] space-y-1.5 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="text-xs text-ink-faint">No payments yet — run START DEMO.</p>
          ) : (
            rows.map((payment) => (
              <button
                key={payment.id}
                type="button"
                onClick={() => {
                  setSelectedId(payment.id);
                }}
                className={`block w-full rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                  selectedId === payment.id
                    ? 'border-brand-400 bg-brand-50 shadow-card'
                    : 'border-ink-line bg-white hover:border-brand-200 hover:bg-canvas-mist'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={paymentTone(payment.state)}>{payment.state}</Badge>
                  <span className="font-mono text-[10px] text-ink-faint">{timeOf(payment.createdAt)}</span>
                </div>
                <p className="mt-1 font-mono text-[11px] text-ink">
                  ₹{(payment.amountPaise / 100).toLocaleString('en-IN')} · {payment.agentId}
                </p>
                {payment.duplicate ? (
                  <p className="mt-0.5 text-[10px] text-review">duplicate execution prevented</p>
                ) : null}
              </button>
            ))
          )}
        </div>
        {payments.error !== null ? <p className="mt-2 text-xs text-block">{errMessage(payments.error)}</p> : null}
      </Card>

      <div className="space-y-6">
        {selected !== null ? (
          <>
            <PaymentTimeline payment={selected} />
            <Card
              title="UNKNOWN Resolution"
              subtitle="UNKNOWN payments are reconciled — never blindly retried"
              right={
                reconcileResult !== null ? (
                  <Badge tone={resolutionTone(reconcileResult.resolution)}>
                    {reconcileResult.resolution}
                  </Badge>
                ) : null
              }
            >
              <Button
                variant="primary"
                loading={reconcile.isPending}
                disabled={selected.state !== 'UNKNOWN' && selected.state !== 'PENDING'}
                onClick={() =>
                  reconcile.mutate(selected.id, {
                    onSuccess: (r) => setReconcileFor({ paymentId: selected.id, report: r }),
                  })
                }
              >
                Reconcile with provider
              </Button>
              {reconcile.error !== null ? (
                <p className="mt-2 text-xs text-block">{errMessage(reconcile.error)}</p>
              ) : null}
              {reconcileResult !== null ? (
                <div className="mt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge tone={resolutionTone(reconcileResult.resolution)}>resolution</Badge>
                    <span className="text-ink">{reconcileResult.resolution}</span>
                    <span className="font-mono text-[10px] text-ink-faint">
                      retried={String(reconcileResult.retried)}
                    </span>
                  </div>
                  <p className="mt-1 text-ink-soft">{reconcileResult.detail}</p>
                </div>
              ) : null}
            </Card>
            <ProviderEventForm
              loading={providerEvent.isPending}
              result={eventResult}
              onSubmit={(event, state) =>
                providerEvent.mutate(
                  { paymentId: selected.id, event, state },
                  { onSuccess: (r) => setEventFor({ paymentId: selected.id, result: r }) },
                )
              }
            />
          </>
        ) : (
          <Card title="Payment">
            <p className="text-xs text-ink-faint">Select a payment.</p>
          </Card>
        )}
      </div>
    </div>
  );
}