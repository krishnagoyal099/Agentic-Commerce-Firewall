// apps/api/src/services/PaymentService.ts
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import {
  COMMITTED_SPEND_STATES,
  canTransition,
  formatINR,
  type PaymentDTO,
  type PaymentEventDTO,
  type PaymentState,
} from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { PaymentEventRow, PaymentRow, PolicyRow } from '../db/schema';
import * as schema from '../db/schema';
import type { PaymentProvider } from '../providers/PaymentProvider';
import {
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../providers/PaymentProvider';
import type { Clock } from '../utils/clock';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import type { AuditService } from './AuditService';
import type { CartIntegrityService } from './CartIntegrityService';
import type { CartService, CartView } from './CartService';
import type { MandateService } from './MandateService';
import type { PolicyEngine } from './PolicyEngine';

export interface ProviderEventResult {
  paymentId: string;
  eventName: string;
  applied: boolean;
  duplicate: boolean;
  ignored: boolean;
  state: PaymentState;
  detail: string;
}

/**
 * Payment execution layer (§26, §27, §29, §59).
 *
 * INVARIANT — no payment is ever sent to a provider unless, at execution time:
 *   1. an AuthorizationDecision exists for this exact action,
 *   2. it is ALLOW, or HUMAN_APPROVAL that a human has since approved,
 *   3. it has not been consumed before (single-use),
 *   4. the mandate is still active and unexpired,
 *   5. the cart is open and its recomputed hash matches the authorized hash,
 *   6. current merchant money limits still pass (fail-closed recheck),
 *   7. the decision is within the authorization TTL,
 *   8. no payment already exists for the idempotency key (replay → original).
 *
 * Agents, MCP tools, growth proposals, and routes all enter through
 * executePayment(); none of them can reach the provider directly.
 */
export class PaymentService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly provider: PaymentProvider,
    private readonly merchantId: string,
    private readonly carts: CartService,
    private readonly cartIntegrity: CartIntegrityService,
    private readonly mandates: MandateService,
    private readonly policies: PolicyEngine,
  ) {}

  // ---------- public: execution ----------

  async executePayment(decisionId: string): Promise<PaymentDTO> {
    const decision = this.db
      .select()
      .from(schema.authorizationDecisions)
      .where(eq(schema.authorizationDecisions.id, decisionId))
      .get();
    if (!decision) {
      throw new DomainError('DECISION_NOT_FOUND', `Authorization decision ${decisionId} does not exist.`);
    }

    // ---- Layer 1: idempotency. A replay NEVER produces a second charge. ----
    const existing = this.findPaymentRowByIdempotencyKey(decision.idempotencyKey);
    if (existing) {
      // AuthorizationEngine.findDuplicate scopes replays to
      // (agentId, actionType, idempotencyKey), but this lookup was keyed on the
      // idempotency key ALONE. A key reused by a different agent therefore
      // sailed past the engine as a fresh action and then resolved here to the
      // FIRST agent's payment: the second cart was never charged, its decision
      // never consumed, and the caller received someone else's CAPTURED
      // payment as proof of success. Ownership must match, or this is not a
      // replay at all.
      if (existing.agentId !== decision.agentId) {
        throw new DomainError(
          'IDEMPOTENCY_KEY_CONFLICT',
          `Idempotency key ${decision.idempotencyKey} already belongs to a payment by a different agent; it cannot be reused.`,
        );
      }
      this.recordReplay(existing, decisionId);
      // duplicate flags THIS response, not the payment. Persisting it left a
      // perfectly good CAPTURED payment marked a duplicate for ever in
      // GET /api/payments and on the dashboard.
      return { ...this.toDTO(this.getPaymentRowOrThrow(existing.id)), duplicate: true };
    }

    // ---- Layer 2: the §59 invariant chain. ----
    if (decision.actionType !== 'payment.create') {
      throw new DomainError(
        'DECISION_ACTION_MISMATCH',
        `Decision ${decisionId} is for action type ${decision.actionType}; payment execution requires payment.create.`,
      );
    }
    const authorized =
      decision.decision === 'ALLOW' ||
      (decision.decision === 'HUMAN_APPROVAL' && decision.approvedAt !== null);
    if (!authorized) {
      throw new DomainError(
        'DECISION_NOT_AUTHORIZED',
        `Decision ${decisionId} is ${decision.decision}${
          decision.decision === 'HUMAN_APPROVAL' ? ' (not yet approved by a human)' : ''
        }; it does not authorize payment execution.`,
      );
    }
    if (decision.consumedAt !== null) {
      throw new DomainError('DECISION_ALREADY_CONSUMED', `Decision ${decisionId} was already executed exactly once.`);
    }
    if (decision.cartId === null || decision.mandateId === null || decision.amountPaise === null) {
      throw new DomainError('DECISION_INCOMPLETE', `Decision ${decisionId} lacks cart, mandate, or amount context.`);
    }

    const cartView = this.carts.getCart(decision.cartId);
    if (!cartView) {
      throw new DomainError('CART_NOT_FOUND', `Cart ${decision.cartId} does not exist.`);
    }
    if (cartView.cart.state !== 'open') {
      throw new DomainError(
        'CART_NOT_EXECUTABLE',
        `Cart ${decision.cartId} is ${cartView.cart.state}; payment execution requires an open cart with a fresh authorization.`,
      );
    }
    const freshHash = this.cartIntegrity.hashForCart(decision.cartId);
    if (freshHash === null || freshHash !== decision.cartHash) {
      throw new DomainError(
        'CART_CHANGED_AT_EXECUTION',
        'Cart contents changed since authorization (hash mismatch); reauthorization required.',
      );
    }

    const mandate = this.mandates.getMandate(decision.mandateId);
    if (!mandate) {
      throw new DomainError('MANDATE_NOT_FOUND', `Mandate ${decision.mandateId} does not exist.`);
    }
    if (mandate.effectiveStatus !== 'active') {
      throw new DomainError(
        'MANDATE_INVALID_AT_EXECUTION',
        `Mandate ${decision.mandateId} is ${mandate.effectiveStatus}; payment execution requires an active mandate.`,
      );
    }

    const policy = this.policies.getActivePolicy(this.merchantId);
    if (!policy) {
      throw new DomainError('POLICY_MISSING', `Merchant policy is not configured for ${this.merchantId}.`);
    }

    const discountPaise = decision.receipt.action.discountPaise ?? 0;
    const totalPaise = decision.amountPaise;
    if (cartView.subtotalPaise - discountPaise !== totalPaise) {
      throw new DomainError(
        'CART_CHANGED_AT_EXECUTION',
        `Cart total ${formatINR(cartView.subtotalPaise - discountPaise)} no longer matches the authorized amount ${formatINR(totalPaise)}.`,
      );
    }
    if (totalPaise > policy.maxOrderAmountPaise) {
      throw new DomainError(
        'EXECUTION_POLICY_VIOLATION',
        `Order total ${formatINR(totalPaise)} exceeds current merchant limit ${formatINR(policy.maxOrderAmountPaise)}.`,
      );
    }
    if (discountPaise > policy.maxDiscountPaise) {
      throw new DomainError(
        'EXECUTION_POLICY_VIOLATION',
        `Discount ${formatINR(discountPaise)} exceeds current merchant limit ${formatINR(policy.maxDiscountPaise)}.`,
      );
    }
    const committed = this.getCommittedSpendToday();
    if (committed + totalPaise > policy.dailyBudgetPaise) {
      throw new DomainError(
        'EXECUTION_POLICY_VIOLATION',
        `Committed spend today ${formatINR(committed)} plus this payment ${formatINR(totalPaise)} exceeds the daily budget ${formatINR(policy.dailyBudgetPaise)}.`,
      );
    }
    const marginPaise =
      cartView.lines.reduce(
        (sum, line) => sum + Math.round((line.unitPricePaise * line.quantity * line.marginPercent) / 100),
        0,
      ) - discountPaise;
    if (totalPaise <= 0 || (marginPaise / totalPaise) * 100 < policy.minimumMarginPercent) {
      throw new DomainError(
        'EXECUTION_POLICY_VIOLATION',
        `Effective margin ${totalPaise > 0 ? ((marginPaise / totalPaise) * 100).toFixed(1) : '0.0'}% is below the merchant minimum ${policy.minimumMarginPercent}%.`,
      );
    }
    const expiresAtMs = Date.parse(decision.createdAt) + policy.authorizationTtlMinutes * 60_000;
    if (this.clock.now().getTime() > expiresAtMs) {
      throw new DomainError(
        'AUTHORIZATION_TTL_EXPIRED',
        `Authorization for decision ${decisionId} expired (TTL ${policy.authorizationTtlMinutes} minutes); reauthorization required.`,
      );
    }

    // ---- Layer 3: mutate — cart authorization, order, payment row. ----
    const nowIso = this.clock.now().toISOString();
    const orderId = newId('ord');
    const paymentId = newId('pay');
    let authorizationApplied = false;
    try {
      this.carts.applyAuthorization(
        decision.cartId,
        discountPaise,
        decisionId,
        new Date(expiresAtMs).toISOString(),
      );
      authorizationApplied = true;
      this.db
        .insert(schema.orders)
        .values({
          id: orderId,
          cartId: decision.cartId,
          mandateId: decision.mandateId,
          agentId: decision.agentId,
          status: 'pending',
          totalPaise,
          productIds: cartView.lines.map((line) => line.productId),
          protocol: decision.protocol,
          createdAt: nowIso,
          completedAt: null,
        })
        .run();
      this.db
        .insert(schema.payments)
        .values({
          id: paymentId,
          orderId,
          decisionId,
          agentId: decision.agentId,
          idempotencyKey: decision.idempotencyKey,
          provider: this.provider.name,
          providerPaymentId: null,
          state: 'CREATED',
          amountPaise: totalPaise,
          currency: 'INR',
          duplicate: false,
          reconciled: false,
          failureReason: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
    } catch (err) {
      if (authorizationApplied) {
        this.carts.releaseAuthorization(decision.cartId);
      }
      // Child before parent: payments.order_id references orders.id and
      // PRAGMA foreign_keys is ON, so deleting the order first would throw a
      // constraint error from inside the rollback, mask the original failure
      // and leave both rows behind.
      this.db.delete(schema.payments).where(eq(schema.payments.id, paymentId)).run();
      this.db.delete(schema.orders).where(eq(schema.orders.id, orderId)).run();
      throw err;
    }

    // Mark the decision spent. CartService does this for every cart action, but
    // payment execution never did — so the single-use guard at the top of this
    // method ("Layer 2") was unreachable, and MetricsService.autonomousActions,
    // which counts consumed decisions, omitted every completed purchase.
    this.db
      .update(schema.authorizationDecisions)
      .set({ consumedAt: nowIso })
      .where(eq(schema.authorizationDecisions.id, decisionId))
      .run();

    this.audit.append({
      actor: decision.agentId,
      eventType: 'PAYMENT_REQUEST',
      action: 'payment.execute',
      reason: `Payment of ${formatINR(totalPaise)} authorized by decision ${decisionId}; dispatching to ${this.provider.name} provider.`,
      inputHash: sha256JSON({ paymentId, decisionId, orderId, totalPaise }),
      policyVersion: policy.version,
      payload: {
        paymentId,
        decisionId,
        orderId,
        cartId: decision.cartId,
        agentId: decision.agentId,
        amountPaise: totalPaise,
        discountPaise,
        provider: this.provider.name,
        protocol: decision.protocol,
      },
    });

    // ---- Layer 4: provider execution (state-machine-guarded). ----
    try {
      this.transition(paymentId, 'PENDING', 'provider.requested', 'Create request dispatched to provider.');
      const created = await this.provider.createPayment({
        amountPaise: totalPaise,
        currency: 'INR',
        receipt: paymentId,
        notes: {
          orderId,
          decisionId,
          agentId: decision.agentId,
          mandateId: decision.mandateId,
        },
      });
      this.setProviderPaymentId(paymentId, created.providerPaymentId);
      if (created.state === 'CAPTURED') {
        this.transition(paymentId, 'CAPTURED', 'provider.captured', created.message ?? 'Payment was already captured at provider.');
        this.completeOrderForPayment(paymentId);
      } else if (created.state === 'AUTHORIZED') {
        this.transition(paymentId, 'AUTHORIZED', 'provider.authorized', created.message ?? 'Funds authorized at provider.');
        await this.captureExisting(paymentId);
      } else if (created.state === 'FAILED') {
        this.transition(paymentId, 'FAILED', 'provider.rejected', created.message ?? 'Provider rejected the payment.');
        this.failOrderForPayment(paymentId, 'Provider rejected the payment.');
      } else {
        // PENDING: provider created the payment but completion is external
        // (e.g. Razorpay order awaiting buyer-side payment completion).
        this.recordEvent(
          paymentId,
          'provider.pending',
          'PENDING',
          created.message ?? 'Payment pending at provider; awaiting completion.',
          false,
          false,
        );
      }
    } catch (err) {
      if (err instanceof ProviderTimeoutError) {
        this.transition(
          paymentId,
          'UNKNOWN',
          'provider.timeout',
          `${err.message} State UNKNOWN; reconciliation is required before any retry — never blind-retry.`,
        );
      } else if (err instanceof ProviderRejectedError) {
        this.transition(paymentId, 'FAILED', 'provider.rejected', err.message);
        this.failOrderForPayment(paymentId, 'Provider rejected the payment.');
      } else if (err instanceof ProviderUnavailableError) {
        this.transition(paymentId, 'FAILED', 'provider.unavailable', err.message);
        this.failOrderForPayment(paymentId, 'Provider unavailable.');
      } else {
        throw err;
      }
    }

    return this.toDTO(this.getPaymentRowOrThrow(paymentId));
  }

  /**
   * Captures an AUTHORIZED payment. Idempotent for the provider; on transient
   * provider errors the payment stays AUTHORIZED (safe: capture can be retried
   * through reconciliation; a network error is never interpreted as failure).
   */
  async captureExisting(paymentId: string): Promise<PaymentRow> {
    let row = this.getPaymentRowOrThrow(paymentId);
    if (row.state !== 'AUTHORIZED') {
      return row;
    }
    if (row.providerPaymentId === null) {
      this.recordEvent(paymentId, 'capture.skipped', null, 'No provider payment id yet; capture deferred.', false, false);
      return this.getPaymentRowOrThrow(paymentId);
    }
    try {
      const result = await this.provider.capturePayment(row.providerPaymentId, row.amountPaise);
      if (result.state === 'CAPTURED') {
        row = this.transition(paymentId, 'CAPTURED', 'provider.capture', `Captured ${formatINR(row.amountPaise)} at provider.`);
        this.completeOrderForPayment(paymentId);
      } else {
        this.recordEvent(
          paymentId,
          'provider.capture_deferred',
          result.state,
          result.message ?? 'Capture not yet possible; payment remains authorized.',
          false,
          false,
        );
      }
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        row = this.transition(paymentId, 'FAILED', 'provider.capture_failed', err.message);
        this.failOrderForPayment(paymentId, 'Capture rejected by provider.');
      } else if (err instanceof ProviderTimeoutError || err instanceof ProviderUnavailableError) {
        this.recordEvent(
          paymentId,
          'provider.capture_error',
          null,
          `Capture call failed (${err instanceof Error ? err.message : 'unknown'}); payment remains AUTHORIZED — retry via reconciliation, never blind-retry.`,
          false,
          false,
        );
      } else {
        throw err;
      }
    }
    return this.getPaymentRowOrThrow(paymentId);
  }

  // ---------- public: state machine primitives ----------

  transition(paymentId: string, toState: PaymentState, eventName: string, detail: string, eventKey?: string): PaymentRow {
    const row = this.getPaymentRowOrThrow(paymentId);
    if (!canTransition(row.state, toState)) {
      throw new DomainError(
        'INVALID_PAYMENT_TRANSITION',
        `${row.state} → ${toState} is not a legal payment transition (event ${eventName}).`,
      );
    }
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.payments)
      .set({ state: toState, updatedAt: nowIso })
      .where(eq(schema.payments.id, paymentId))
      .run();
    this.insertEvent(row, eventName, toState, detail, false, false, eventKey);
    this.audit.append({
      actor: 'payment-service',
      eventType: 'PAYMENT_EVENT',
      action: `payment.${toState.toLowerCase()}`,
      reason: detail,
      inputHash: sha256JSON({ paymentId, from: row.state, to: toState, eventName }),
      payload: { paymentId, from: row.state, to: toState, eventName, amountPaise: row.amountPaise },
    });
    return this.getPaymentRowOrThrow(paymentId);
  }

  /** Records a timeline event without a state transition (informational). */
  recordEvent(
    paymentId: string,
    eventName: string,
    state: PaymentState | null,
    detail: string,
    duplicate: boolean,
    ignored: boolean,
  ): void {
    const row = this.getPaymentRowOrThrow(paymentId);
    this.insertEvent(row, eventName, state, detail, duplicate, ignored);
  }

  markReconciled(paymentId: string): void {
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.payments)
      .set({ reconciled: true, updatedAt: nowIso })
      .where(eq(schema.payments.id, paymentId))
      .run();
  }

  setProviderPaymentId(paymentId: string, providerPaymentId: string): void {
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.payments)
      .set({ providerPaymentId, updatedAt: nowIso })
      .where(eq(schema.payments.id, paymentId))
      .run();
  }

  /**
   * Provider webhook ingestion (§29): duplicate events are detected and
   * ignored; events implying an illegal transition (out-of-order) are recorded
   * but never applied.
   */
  handleProviderEvent(
    paymentId: string,
    eventName: string,
    targetState: PaymentState | null,
    detail?: string,
  ): ProviderEventResult {
    const row = this.getPaymentRowOrThrow(paymentId);
    const baseKey = `${row.providerPaymentId ?? row.id}:${eventName}`;

    // Scoped to THIS payment. providerPaymentId is not globally unique — the
    // mock provider restarts its counter for every ServiceContext, and the
    // history bootstrap builds one per simulated day — so a global match on
    // eventKey silently discarded a genuine capture webhook for payment B
    // because payment A had already seen the same event name under a colliding
    // provider id, leaving a real charge stuck PENDING for ever.
    const prior = this.db
      .select({ id: schema.paymentEvents.id })
      .from(schema.paymentEvents)
      .where(and(eq(schema.paymentEvents.paymentId, row.id), eq(schema.paymentEvents.eventKey, baseKey)))
      .limit(1)
      .get();
    if (prior) {
      const priorCount = this.db
        .select({ id: schema.paymentEvents.id })
        .from(schema.paymentEvents)
        .where(
          and(
            eq(schema.paymentEvents.paymentId, row.id),
            eq(schema.paymentEvents.event, eventName),
            eq(schema.paymentEvents.duplicate, true),
          ),
        )
        .all().length;
      const dupDetail = detail ?? `Duplicate provider event "${eventName}" detected and ignored.`;
      this.insertEvent(row, eventName, targetState, dupDetail, true, true, `${baseKey}#dup-${priorCount + 1}`);
      this.audit.append({
        actor: 'payment-service',
        eventType: 'PAYMENT_EVENT',
        action: 'payment.duplicate_event_ignored',
        reason: dupDetail,
        inputHash: sha256JSON({ paymentId, eventName, baseKey }),
        payload: { paymentId, eventName, duplicate: true },
      });
      return {
        paymentId,
        eventName,
        applied: false,
        duplicate: true,
        ignored: true,
        state: row.state,
        detail: dupDetail,
      };
    }

    if (targetState !== null && !canTransition(row.state, targetState)) {
      const ignoredDetail =
        detail ?? `Ignored: ${row.state} → ${targetState} is not a legal transition (out-of-order provider event).`;
      this.insertEvent(row, eventName, targetState, ignoredDetail, false, true, baseKey);
      return {
        paymentId,
        eventName,
        applied: false,
        duplicate: false,
        ignored: true,
        state: row.state,
        detail: ignoredDetail,
      };
    }

    if (targetState !== null) {
      const wasUnknown = row.state === 'UNKNOWN';
      this.transition(paymentId, targetState, eventName, detail ?? `Provider event applied: ${eventName}.`, baseKey);
      if (wasUnknown) {
        this.markReconciled(paymentId);
      }
      if (targetState === 'CAPTURED') {
        this.completeOrderForPayment(paymentId);
      }
      if (targetState === 'FAILED' || targetState === 'CANCELLED') {
        this.failOrderForPayment(paymentId, `Provider event ${eventName} failed the payment.`);
      }
      return {
        paymentId,
        eventName,
        applied: true,
        duplicate: false,
        ignored: false,
        state: targetState,
        detail: detail ?? `Provider event applied: ${eventName}.`,
      };
    }

    this.insertEvent(row, eventName, null, detail ?? `Provider event: ${eventName}`, false, false, baseKey);
    return {
      paymentId,
      eventName,
      applied: false,
      duplicate: false,
      ignored: false,
      state: row.state,
      detail: detail ?? `Provider event: ${eventName}`,
    };
  }

  completeOrderForPayment(paymentId: string): void {
    const row = this.getPaymentRowOrThrow(paymentId);
    if (row.orderId === null) return;
    const order = this.db.select().from(schema.orders).where(eq(schema.orders.id, row.orderId)).get();
    if (!order || order.status !== 'pending') return;
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.orders)
      .set({ status: 'completed', completedAt: nowIso })
      .where(eq(schema.orders.id, order.id))
      .run();
    // The cart can be mutated while the provider call is in flight (addItems
    // only refuses a paid cart), which moves it authorized -> stale and changes
    // its hash. Marking it paid regardless recorded items that were never
    // charged — and GrowthAnalytics then counted them as paid co-purchases.
    // The ORDER is authoritative either way: its lines were snapshotted at
    // authorization, so the charge itself is correct.
    const cartNow = this.carts.getCart(order.cartId);
    const freshHash = this.cartIntegrity.hashForCart(order.cartId);
    const authorizedHash = cartNow?.cart.authorizedHash ?? null;
    if (freshHash !== null && authorizedHash !== null && freshHash !== authorizedHash) {
      this.recordEvent(
        paymentId,
        'cart.diverged_after_authorization',
        null,
        `Cart ${order.cartId} changed after authorization (${authorizedHash.slice(0, 10)}… -> ${freshHash.slice(0, 10)}…). The order stands on the lines that were authorized and charged; the cart was NOT marked paid.`,
        false,
        false,
      );
    } else {
      this.carts.markPaid(order.cartId);
    }
    this.audit.append({
      actor: 'payment-service',
      eventType: 'ORDER_COMPLETED',
      action: 'order.completed',
      reason: `Order ${order.id} completed; payment ${paymentId} captured ${formatINR(row.amountPaise)}.`,
      inputHash: sha256JSON({ orderId: order.id, paymentId, totalPaise: order.totalPaise }),
      payload: {
        orderId: order.id,
        paymentId,
        cartId: order.cartId,
        totalPaise: order.totalPaise,
        agentId: order.agentId,
        productIds: order.productIds,
      },
    });
  }

  failOrderForPayment(paymentId: string, reason: string): void {
    const row = this.getPaymentRowOrThrow(paymentId);
    this.db
      .update(schema.payments)
      .set({ failureReason: reason, updatedAt: this.clock.now().toISOString() })
      .where(eq(schema.payments.id, paymentId))
      .run();
    if (row.orderId !== null) {
      const order = this.db.select().from(schema.orders).where(eq(schema.orders.id, row.orderId)).get();
      if (order && order.status === 'pending') {
        this.db
          .update(schema.orders)
          .set({ status: 'failed' })
          .where(eq(schema.orders.id, order.id))
          .run();
      }
      if (order) {
        this.carts.releaseAuthorization(order.cartId);
      }
    }
    this.audit.append({
      actor: 'payment-service',
      eventType: 'PAYMENT_EVENT',
      action: 'order.failed',
      reason,
      inputHash: sha256JSON({ paymentId, reason }),
      payload: { paymentId, orderId: row.orderId, reason },
    });
  }

  // ---------- public: queries ----------

  getPaymentRow(paymentId: string): PaymentRow | null {
    return this.db.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).get() ?? null;
  }

  getPaymentRowOrThrow(paymentId: string): PaymentRow {
    const row = this.getPaymentRow(paymentId);
    if (!row) {
      throw new DomainError('PAYMENT_NOT_FOUND', `Payment ${paymentId} does not exist.`);
    }
    return row;
  }

  getPayment(paymentId: string): PaymentDTO | null {
    const row = this.getPaymentRow(paymentId);
    return row ? this.toDTO(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string): PaymentDTO | null {
    const row = this.findPaymentRowByIdempotencyKey(idempotencyKey);
    return row ? this.toDTO(row) : null;
  }

  listPayments(limit = 50): PaymentDTO[] {
    const bounded = Math.min(Math.max(limit, 1), 200);
    return this.db
      .select()
      .from(schema.payments)
      .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
      .limit(bounded)
      .all()
      .map((row) => this.toDTO(row));
  }

  getRevenueCapturedPaise(): number {
    const rows = this.db
      .select({ amountPaise: schema.payments.amountPaise })
      .from(schema.payments)
      .where(eq(schema.payments.state, 'CAPTURED'))
      .all();
    return rows.reduce((sum, row) => sum + row.amountPaise, 0);
  }

  countDuplicatePreventions(): number {
    return this.db
      .select({ id: schema.paymentEvents.id })
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.duplicate, true))
      .all().length;
  }

  /**
   * Merchant daily budget committed today. The AuthorizationEngine performs
   * the authoritative check during evaluation; this re-verification at
   * execution is defense in depth against state changing between evaluation
   * and execution.
   */
  getCommittedSpendToday(): number {
    const today = this.clock.now().toISOString().slice(0, 10);
    const rows = this.db
      .select({ amountPaise: schema.payments.amountPaise })
      .from(schema.payments)
      .where(
        and(
          like(schema.payments.createdAt, `${today}%`),
          inArray(schema.payments.state, [...COMMITTED_SPEND_STATES]),
        ),
      )
      .all();
    return rows.reduce((sum, row) => sum + row.amountPaise, 0);
  }

  // ---------- private ----------

  private findPaymentRowByIdempotencyKey(idempotencyKey: string): PaymentRow | null {
    return (
      this.db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.idempotencyKey, idempotencyKey))
        .get() ?? null
    );
  }

  private recordReplay(existing: PaymentRow, decisionId: string): void {
    const priorCount = this.db
      .select({ id: schema.paymentEvents.id })
      .from(schema.paymentEvents)
      .where(
        and(
          eq(schema.paymentEvents.paymentId, existing.id),
          eq(schema.paymentEvents.event, 'create.replay_ignored'),
        ),
      )
      .all().length;
    const detail = `Duplicate payment execution prevented (idempotency key ${existing.idempotencyKey}; decision ${decisionId}). No second charge created.`;
    this.insertEvent(
      existing,
      'create.replay_ignored',
      null,
      detail,
      true,
      true,
      `replay:${existing.id}:${priorCount + 1}`,
    );
    // The create.replay_ignored event above is the durable record of the
    // prevention (and what countDuplicatePreventions reads); the payment row
    // itself is not a duplicate and must not be relabelled as one.
    this.audit.append({
      actor: 'payment-service',
      eventType: 'PAYMENT_EVENT',
      action: 'payment.duplicate_prevented',
      reason: detail,
      inputHash: sha256JSON({ paymentId: existing.id, idempotencyKey: existing.idempotencyKey, decisionId }),
      payload: { paymentId: existing.id, idempotencyKey: existing.idempotencyKey, decisionId },
    });
  }

  private insertEvent(
    row: PaymentRow,
    eventName: string,
    state: PaymentState | null,
    detail: string,
    duplicate: boolean,
    ignored: boolean,
    eventKey?: string,
  ): void {
    this.db
      .insert(schema.paymentEvents)
      .values({
        id: newId('pevt'),
        paymentId: row.id,
        eventKey: eventKey ?? `${row.providerPaymentId ?? row.id}:${eventName}:${newId('evk')}`,
        event: eventName,
        state,
        detail,
        duplicate,
        ignored,
        at: this.clock.now().toISOString(),
      })
      .run();
  }

  toDTO(row: PaymentRow): PaymentDTO {
    const events: PaymentEventRow[] = this.db
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.paymentId, row.id))
      .orderBy(sql`rowid`)
      .all();
    const timeline: PaymentEventDTO[] = events.map((e) => ({
      event: e.event,
      state: e.state ?? null,
      detail: e.detail,
      at: e.at,
      duplicate: e.duplicate,
      ignored: e.ignored,
    }));
    return {
      id: row.id,
      orderId: row.orderId ?? null,
      decisionId: row.decisionId ?? null,
      agentId: row.agentId,
      idempotencyKey: row.idempotencyKey,
      provider: row.provider,
      providerPaymentId: row.providerPaymentId ?? null,
      state: row.state,
      amountPaise: row.amountPaise,
      currency: 'INR',
      duplicate: row.duplicate,
      reconciled: row.reconciled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      timeline,
    };
  }
}