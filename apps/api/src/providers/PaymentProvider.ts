// apps/api/src/providers/PaymentProvider.ts
import type { PaymentProviderName, ProviderPaymentResult } from '@acsf/shared';

export interface ProviderCreateRequest {
  amountPaise: number;
  currency: 'INR';
  /** Our internal payment id — the provider-side correlation key. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface ProviderQueryResult {
  found: boolean;
  payment: ProviderPaymentResult | null;
  message: string;
}

/**
 * Payment provider contract (§26) plus `queryByReceipt`, required for honest
 * UNKNOWN reconciliation: when createPayment times out, the caller may never
 * have received a provider id, so the provider must be queryable by our
 * receipt id before any retry decision is made.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createPayment(request: ProviderCreateRequest): Promise<ProviderPaymentResult>;
  queryPayment(providerPaymentId: string): Promise<ProviderQueryResult>;
  queryByReceipt(receipt: string): Promise<ProviderQueryResult>;
  capturePayment(providerPaymentId: string, amountPaise: number): Promise<ProviderPaymentResult>;
  cancelPayment(providerPaymentId: string): Promise<ProviderPaymentResult>;
}

/** Create request was dispatched but no response arrived — state must become UNKNOWN. */
export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/** Provider processed and refused the operation. */
export class ProviderRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRejectedError';
  }
}

/** Provider unreachable — never interpreted as success or failure. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}