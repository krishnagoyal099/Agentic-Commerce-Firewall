// packages/shared/src/payment.ts  (MODIFIED — full reprint)
/**
 * Payment states (§27) and legal transitions. Invalid transitions are rejected;
 * duplicate and out-of-order provider events are recorded but ignored (§29).
 */
export const PAYMENT_STATES = [
  'CREATED',
  'PENDING',
  'UNKNOWN',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  CREATED: ['PENDING', 'FAILED', 'CANCELLED'],
  PENDING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN', 'CANCELLED'],
  UNKNOWN: ['CAPTURED', 'AUTHORIZED', 'FAILED'],
  AUTHORIZED: ['CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

/**
 * States whose amount counts against the merchant's daily budget.
 *
 * UNKNOWN is included deliberately: it is what a provider timeout leaves
 * behind, and the money may already have moved. Reconciliation is what
 * resolves it; until then the safe assumption is that it was spent. This lives
 * here because the AuthorizationEngine (decide time) and PaymentService
 * (execute time) must never disagree about it.
 */
export const COMMITTED_SPEND_STATES = ['CAPTURED', 'AUTHORIZED', 'PENDING', 'UNKNOWN'] as const;

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export type PaymentProviderName = 'mock' | 'razorpay';

/** Result shape returned by every PaymentProvider operation. */
export interface ProviderPaymentResult {
  providerPaymentId: string;
  state: PaymentState;
  amountPaise: number;
  message: string | null;
  capturedAt: string | null;
}

export interface PaymentEventDTO {
  event: string;
  state: PaymentState | null;
  detail: string;
  at: string;
  duplicate: boolean;
  ignored: boolean;
}

export interface PaymentDTO {
  id: string;
  orderId: string | null;
  decisionId: string | null;
  agentId: string;
  idempotencyKey: string;
  provider: PaymentProviderName;
  providerPaymentId: string | null;
  state: PaymentState;
  amountPaise: number;
  currency: 'INR';
  /** True when the request that produced this response was deduplicated. */
  duplicate: boolean;
  reconciled: boolean;
  createdAt: string;
  updatedAt: string;
  timeline: PaymentEventDTO[];
}

/** Outcomes of reconciling an UNKNOWN (or syncing a PENDING) payment (§28). */
export const RECONCILIATION_RESOLUTIONS = [
  'ALREADY_CAPTURED_NO_RETRY',
  'SAFE_RETRY',
  'RESUMED_AND_CAPTURED',
  'PROVIDER_FAILED',
  'SYNCED_FROM_PROVIDER',
  'NOT_APPLICABLE',
] as const;
export type ReconciliationResolution = (typeof RECONCILIATION_RESOLUTIONS)[number];

export interface ReconciliationReportDTO {
  paymentId: string;
  resolution: ReconciliationResolution;
  detail: string;
  retried: boolean;
  resolvedAt: string;
  payment: PaymentDTO;
}