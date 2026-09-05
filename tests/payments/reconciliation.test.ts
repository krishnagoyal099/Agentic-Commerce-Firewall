// tests/payments/reconciliation.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCart,
  createStandardMandate,
  createTestApp,
  mockProvider,
  payCart,
  type TestApp,
} from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

describe('UNKNOWN payment reconciliation (§28, §69)', () => {
  it('UNKNOWN + provider CAPTURED → no retry, reconciled, order completed', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [
      { productId: 'shoe-001', quantity: 1 },
      { productId: 'sock-001', quantity: 1 },
    ]);
    mockProvider(t.ctx).arm('timeout_then_captured');
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('UNKNOWN');

    // A blind re-execution is refused at the idempotency layer.
    const retry = await t.ctx.payments.executePayment(payment.decisionId ?? '');
    expect(retry.id).toBe(payment.id);
    expect(retry.duplicate).toBe(true);
    expect(t.ctx.payments.getPayment(payment.id)?.state).toBe('UNKNOWN');

    const report = await t.ctx.reconciliation.reconcile(payment.id);
    expect(report.resolution).toBe('ALREADY_CAPTURED_NO_RETRY');
    expect(report.retried).toBe(false);
    expect(report.payment.state).toBe('CAPTURED');
    expect(report.payment.reconciled).toBe(true);
    expect(t.ctx.carts.getCart(cart.id)?.cart.state).toBe('paid');
  });

  it('UNKNOWN + NOT_FOUND → SAFE_RETRY, cart released, fresh proposal captures', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    mockProvider(t.ctx).arm('timeout_then_not_found');
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('UNKNOWN');

    const report = await t.ctx.reconciliation.reconcile(payment.id);
    expect(report.resolution).toBe('SAFE_RETRY');
    expect(report.payment.state).toBe('FAILED');
    expect(report.payment.reconciled).toBe(true);
    expect(t.ctx.carts.getCart(cart.id)?.cart.state).toBe('open');

    // The retry goes through the firewall again as a fresh proposal.
    const captured = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(captured.state).toBe('CAPTURED');
    expect(captured.id).not.toBe(payment.id);
  });

  it('reconciling a terminal payment is a no-op', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    const report = await t.ctx.reconciliation.reconcile(payment.id);
    expect(report.resolution).toBe('NOT_APPLICABLE');
  });
});