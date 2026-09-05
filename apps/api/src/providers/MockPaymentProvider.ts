// apps/api/src/providers/MockPaymentProvider.ts
import type { ProviderPaymentResult } from '@acsf/shared';
import type { Clock } from '../utils/clock';
import type { PaymentProvider, ProviderCreateRequest, ProviderQueryResult } from './PaymentProvider';
import { ProviderRejectedError, ProviderTimeoutError, ProviderUnavailableError } from './PaymentProvider';

/** Deterministic fault injection for the timeout / failure demos and attacks. */
export type MockFaultMode =
  | 'none'
  | 'timeout_then_captured'
  | 'timeout_then_not_found'
  | 'reject';

interface MockPayment {
  id: string;
  receipt: string;
  amountPaise: number;
  state: 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELLED';
  createdAt: string;
  capturedAt: string | null;
}

/**
 * In-process mock provider — the default. Fully deterministic: provider ids
 * are a monotonic counter (`mock_000001`, …) and fault arming is one-shot, so
 * the next payment behaves normally again.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  private readonly clock: Clock;
  private readonly payments = new Map<string, MockPayment>();
  private counter = 0;
  private armed: MockFaultMode = 'none';

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Arms a fault for exactly the next createPayment call. */
  arm(mode: MockFaultMode): void {
    this.armed = mode;
  }

  private nextId(): string {
    this.counter += 1;
    return `mock_${String(this.counter).padStart(6, '0')}`;
  }

  private toResult(p: MockPayment): ProviderPaymentResult {
    return {
      providerPaymentId: p.id,
      state: p.state,
      amountPaise: p.amountPaise,
      message: `Mock payment ${p.id} is ${p.state}.`,
      capturedAt: p.capturedAt,
    };
  }

  async createPayment(request: ProviderCreateRequest): Promise<ProviderPaymentResult> {
    const mode = this.armed;
    this.armed = 'none'; // one-shot
    if (mode === 'reject') {
      throw new ProviderRejectedError('Mock provider: payment rejected (armed fault).');
    }
    if (mode === 'timeout_then_not_found') {
      // The request times out client-side and nothing was created provider-side.
      throw new ProviderTimeoutError('Mock provider: create timed out; no payment was created.');
    }
    const id = this.nextId();
    const nowIso = this.clock.now().toISOString();
    const payment: MockPayment = {
      id,
      receipt: request.receipt,
      amountPaise: request.amountPaise,
      state: 'AUTHORIZED',
      createdAt: nowIso,
      capturedAt: null,
    };
    this.payments.set(id, payment);
    if (mode === 'timeout_then_captured') {
      // The request times out client-side, but the provider actually created
      // AND captured the payment — the classic double-charge trap.
      payment.state = 'CAPTURED';
      payment.capturedAt = nowIso;
      throw new ProviderTimeoutError('Mock provider: create timed out; payment was created and captured provider-side.');
    }
    return this.toResult(payment);
  }

  async capturePayment(providerPaymentId: string, amountPaise: number): Promise<ProviderPaymentResult> {
    void amountPaise;
    const p = this.payments.get(providerPaymentId);
    if (!p) {
      throw new ProviderUnavailableError(`Mock provider: payment ${providerPaymentId} not found.`);
    }
    if (p.state === 'CAPTURED') return this.toResult(p); // idempotent capture
    if (p.state !== 'AUTHORIZED') {
      throw new ProviderRejectedError(`Mock provider: cannot capture payment in state ${p.state}.`);
    }
    p.state = 'CAPTURED';
    p.capturedAt = this.clock.now().toISOString();
    return this.toResult(p);
  }

  async queryPayment(providerPaymentId: string): Promise<ProviderQueryResult> {
    const p = this.payments.get(providerPaymentId);
    if (!p) {
      return { found: false, payment: null, message: `Mock provider: payment ${providerPaymentId} not found.` };
    }
    return { found: true, payment: this.toResult(p), message: `Mock provider: payment ${providerPaymentId} is ${p.state}.` };
  }

  async queryByReceipt(receipt: string): Promise<ProviderQueryResult> {
    for (const p of this.payments.values()) {
      if (p.receipt === receipt) {
        return { found: true, payment: this.toResult(p), message: `Mock provider: payment for receipt ${receipt} is ${p.state}.` };
      }
    }
    return { found: false, payment: null, message: `Mock provider: no payment with receipt ${receipt}.` };
  }

  async cancelPayment(providerPaymentId: string): Promise<ProviderPaymentResult> {
    const p = this.payments.get(providerPaymentId);
    if (!p) {
      throw new ProviderUnavailableError(`Mock provider: payment ${providerPaymentId} not found.`);
    }
    if (p.state !== 'AUTHORIZED') {
      throw new ProviderRejectedError(`Mock provider: cannot cancel payment in state ${p.state}.`);
    }
    p.state = 'CANCELLED';
    return this.toResult(p);
  }

  listProviderPayments(): Array<{ id: string; receipt: string; state: string }> {
    return [...this.payments.values()].map((p) => ({ id: p.id, receipt: p.receipt, state: p.state }));
  }
}