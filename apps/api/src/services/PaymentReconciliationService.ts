// apps/api/src/services/PaymentReconciliationService.ts
import type { ReconciliationReportDTO, ReconciliationResolution } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { PaymentRow } from '../db/schema';
import type { PaymentProvider, ProviderQueryResult } from '../providers/PaymentProvider';
import { ProviderTimeoutError, ProviderUnavailableError } from '../providers/PaymentProvider';
import type { Clock } from '../utils/clock';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import type { AuditService } from './AuditService';
import type { CartService } from './CartService';
import type { PaymentService } from './PaymentService';

/**
 * UNKNOWN payment resolution (§28). NEVER blindly retries:
 *
 *   UNKNOWN → QUERY PROVIDER → CAPTURED        → NO RETRY → RECONCILED
 *   UNKNOWN → QUERY PROVIDER → NOT_FOUND       → SAFE RETRY (fresh authorization)
 *   UNKNOWN → QUERY PROVIDER → AUTHORIZED      → COMPLETE CAPTURE
 *   UNKNOWN → QUERY PROVIDER → FAILED          → ORDER FAILED, CART RELEASED
 *   AUTHORIZED → QUERY PROVIDER → AUTHORIZED    → COMPLETE CAPTURE (rescues a
 *                                                 capture left deferred by a
 *                                                 transient provider error)
 *
 * Provider query failures leave the payment in UNKNOWN — retry the
 * reconciliation, never the payment.
 */
export class PaymentReconciliationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly provider: PaymentProvider,
    private readonly payments: PaymentService,
    private readonly carts: CartService,
  ) {}

  async reconcile(paymentId: string): Promise<ReconciliationReportDTO> {
    void this.db; // payment/cart persistence flows through PaymentService
    const row = this.payments.getPaymentRow(paymentId);
    if (!row) {
      throw new DomainError('PAYMENT_NOT_FOUND', `Payment ${paymentId} does not exist.`);
    }
    const resolvedAt = this.clock.now().toISOString();

    // AUTHORIZED belongs here. captureExisting deliberately leaves a payment
    // AUTHORIZED on a transient provider error and tells the operator to
    // reconcile — but reconcile used to refuse that very state, which made
    // AUTHORIZED a dead end: funds held, order stuck pending, cart stuck
    // authorized, and the amount counted against the daily budget for the rest
    // of the day with no way out.
    if (row.state !== 'UNKNOWN' && row.state !== 'PENDING' && row.state !== 'AUTHORIZED') {
      return this.report(
        this.payments.getPaymentRowOrThrow(paymentId),
        'NOT_APPLICABLE',
        `Payment is ${row.state}; reconciliation applies to UNKNOWN, PENDING and AUTHORIZED payments only.`,
        resolvedAt,
      );
    }

    let query: ProviderQueryResult;
    try {
      // When createPayment timed out we may never have received a provider id —
      // query by our receipt id instead.
      query =
        row.providerPaymentId !== null
          ? await this.provider.queryPayment(row.providerPaymentId)
          : await this.provider.queryByReceipt(row.id);
    } catch (err) {
      if (err instanceof ProviderUnavailableError || err instanceof ProviderTimeoutError) {
        const detail = `Provider query failed (${
          err instanceof Error ? err.message : 'unknown error'
        }); payment remains ${row.state}. Retry reconciliation — never blind-retry the payment.`;
        this.audit.append({
          actor: 'reconciliation',
          eventType: 'PAYMENT_RECONCILIATION',
          action: 'payment.reconcile',
          reason: detail,
          inputHash: sha256JSON({ paymentId, error: true }),
          payload: { paymentId, resolution: 'NOT_APPLICABLE', error: true },
        });
        return this.report(this.payments.getPaymentRowOrThrow(paymentId), 'NOT_APPLICABLE', detail, resolvedAt);
      }
      throw err;
    }

    if (row.providerPaymentId === null && query.found && query.payment !== null) {
      this.payments.setProviderPaymentId(paymentId, query.payment.providerPaymentId);
    }

    // `row` was read before the provider await. Two concurrent reconciles both
    // snapshotted the same state, and the loser then attempted a transition
    // that was no longer legal — throwing INVALID_PAYMENT_TRANSITION out of the
    // route as a 500 and skipping the reconciliation audit event entirely.
    // Branch on the live row instead.
    const current = this.payments.getPaymentRowOrThrow(paymentId);
    if (current.state !== 'UNKNOWN' && current.state !== 'PENDING' && current.state !== 'AUTHORIZED') {
      return this.report(
        current,
        'NOT_APPLICABLE',
        `Payment moved to ${current.state} while the provider was being queried; another reconciliation resolved it first.`,
        resolvedAt,
      );
    }

    let resolution: ReconciliationResolution;
    let detail: string;

    if (!query.found) {
      if (current.state === 'UNKNOWN') {
        this.payments.transition(
          paymentId,
          'FAILED',
          'reconciliation.not_found',
          'Provider reports no such payment; the original attempt never landed. SAFE RETRY with a fresh authorization.',
        );
        this.payments.markReconciled(paymentId);
        this.payments.failOrderForPayment(paymentId, 'Provider reports payment not found (reconciliation).');
        resolution = 'SAFE_RETRY';
        detail =
          'UNKNOWN resolved: payment NOT_FOUND at provider. Cart authorization released; a fresh payment.create proposal is required to retry — no blind retry was performed.';
      } else {
        this.payments.transition(
          paymentId,
          'FAILED',
          'reconciliation.not_found',
          'Provider reports no such payment; failing the pending payment.',
        );
        this.payments.failOrderForPayment(paymentId, 'Provider reports payment not found (reconciliation).');
        resolution = 'SAFE_RETRY';
        detail = 'PENDING payment not found at provider; order failed and cart released for a fresh proposal.';
      }
    } else if (query.payment !== null && query.payment.state === 'CAPTURED') {
      if (current.state === 'UNKNOWN') {
        this.payments.transition(
          paymentId,
          'CAPTURED',
          'reconciliation.already_captured',
          'Provider confirms the payment was already captured. NO RETRY performed; duplicate charge prevented.',
        );
        this.payments.recordEvent(
          paymentId,
          'reconciliation.no_retry',
          null,
          'No retry: payment was already captured at provider; double-charge prevented.',
          false,
          false,
        );
        this.payments.markReconciled(paymentId);
        this.payments.completeOrderForPayment(paymentId);
        resolution = 'ALREADY_CAPTURED_NO_RETRY';
        detail =
          'UNKNOWN resolved: payment was already CAPTURED at provider. No retry performed; order completed; payment marked reconciled.';
      } else {
        this.payments.transition(
          paymentId,
          'CAPTURED',
          'reconciliation.synced_captured',
          'Provider confirms capture; syncing local state.',
        );
        this.payments.completeOrderForPayment(paymentId);
        resolution = 'SYNCED_FROM_PROVIDER';
        detail = 'PENDING payment confirmed CAPTURED at provider; local state synced and order completed.';
      }
    } else if (query.payment !== null && query.payment.state === 'AUTHORIZED') {
      // Already AUTHORIZED locally (the dead-end case this now rescues) needs
      // no transition — AUTHORIZED -> AUTHORIZED is not a legal move.
      if (current.state === 'UNKNOWN') {
        this.payments.transition(
          paymentId,
          'AUTHORIZED',
          'reconciliation.authorized',
          'Provider confirms funds are authorized; completing capture.',
        );
      } else if (current.state === 'PENDING') {
        this.payments.transition(
          paymentId,
          'AUTHORIZED',
          'reconciliation.synced_authorized',
          'Provider confirms authorization; completing capture.',
        );
      }
      const captured = await this.payments.captureExisting(paymentId);
      if (captured.state === 'CAPTURED') {
        this.payments.markReconciled(paymentId);
        resolution = 'RESUMED_AND_CAPTURED';
        detail = 'Provider confirmed authorization and capture completed; order completed.';
      } else if (captured.state === 'FAILED') {
        this.payments.markReconciled(paymentId);
        resolution = 'PROVIDER_FAILED';
        detail = 'Capture failed at provider; order failed and cart released for a fresh proposal.';
      } else {
        // Deliberately NOT marked reconciled: the capture is deferred, so this
        // payment still needs another pass. Marking it resolved here is what
        // made the advice "retry reconciliation later" impossible to follow.
        resolution = 'NOT_APPLICABLE';
        detail = `Capture deferred; payment remains ${captured.state}; reconcile again once the provider reports an authorized payment.`;
      }
    } else if (
      query.payment !== null &&
      (query.payment.state === 'FAILED' || query.payment.state === 'CANCELLED')
    ) {
      this.payments.transition(
        paymentId,
        'FAILED',
        'reconciliation.provider_failed',
        `Provider reports payment ${query.payment.state}.`,
      );
      this.payments.markReconciled(paymentId);
      this.payments.failOrderForPayment(paymentId, `Provider reports payment ${query.payment.state}.`);
      resolution = 'PROVIDER_FAILED';
      detail = `Provider reports the payment ${query.payment.state}; order failed and cart released for a fresh proposal.`;
    } else {
      resolution = 'NOT_APPLICABLE';
      detail = `Provider reports payment ${
        query.payment !== null ? query.payment.state : 'PENDING'
      }; nothing to resolve yet; retry reconciliation later.`;
    }

    this.audit.append({
      actor: 'reconciliation',
      eventType: 'PAYMENT_RECONCILIATION',
      action: 'payment.reconcile',
      reason: detail,
      inputHash: sha256JSON({ paymentId, resolution }),
      payload: {
        paymentId,
        resolution,
        priorState: current.state,
        providerState: query.found ? (query.payment?.state ?? null) : 'NOT_FOUND',
      },
    });
    return this.report(this.payments.getPaymentRowOrThrow(paymentId), resolution, detail, resolvedAt);
  }

  private report(
    row: PaymentRow,
    resolution: ReconciliationResolution,
    detail: string,
    resolvedAt: string,
  ): ReconciliationReportDTO {
    return {
      paymentId: row.id,
      resolution,
      detail,
      retried: false,
      resolvedAt,
      payment: this.payments.toDTO(row),
    };
  }
}