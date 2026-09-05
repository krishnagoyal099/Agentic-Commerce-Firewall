// tests/payments/idempotency.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCart,
  createStandardMandate,
  createTestApp,
  payCart,
  proposePayment,
  type TestApp,
} from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

describe('payment idempotency (§29, §69)', () => {
  it('a duplicate idempotency key produces exactly one payment', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const key = 'idem-test-1';
    const proposal = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id, {
      idempotencyKey: key,
      execute: false,
    });
    expect(proposal.decision).toBe('ALLOW');

    const first = await t.ctx.payments.executePayment(proposal.decisionId ?? '');
    expect(first.duplicate).toBe(false);
    const second = await t.ctx.payments.executePayment(proposal.decisionId ?? '');
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);

    const found = t.ctx.payments.findByIdempotencyKey(key);
    expect(found?.id).toBe(first.id);
    expect(t.ctx.payments.listPayments(200).filter((p) => p.idempotencyKey === key)).toHaveLength(1);
    expect(t.ctx.payments.countDuplicatePreventions()).toBeGreaterThanOrEqual(1);
  });

  it('replaying the same action idempotency key is BLOCKed as a duplicate action', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const key = 'idem-test-2';
    const first = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id, { idempotencyKey: key });
    expect(first.decision).toBe('ALLOW');
    const replay = await proposePayment(t.ctx, 'buyer-agent-01', mandateId, cart.id, { idempotencyKey: key });
    expect(replay.decision).toBe('BLOCK');
    expect(replay.violations.map((v) => v.code)).toContain('DUPLICATE_ACTION');
  });

  it('duplicate provider events are detected and ignored', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);

    const applied = t.ctx.payments.handleProviderEvent(payment.id, 'payment.refunded', 'REFUNDED', 'test refund event');
    expect(applied.applied).toBe(true);
    expect(t.ctx.payments.getPayment(payment.id)?.state).toBe('REFUNDED');

    const replay = t.ctx.payments.handleProviderEvent(payment.id, 'payment.refunded', 'REFUNDED', 'test refund event replay');
    expect(replay.duplicate).toBe(true);
    expect(replay.applied).toBe(false);
    expect(replay.ignored).toBe(true);
  });

  it('out-of-order provider events are recorded but never applied', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    const late = t.ctx.payments.handleProviderEvent(payment.id, 'payment.failed', 'FAILED', 'late failure after capture');
    expect(late.applied).toBe(false);
    expect(late.ignored).toBe(true);
    expect(t.ctx.payments.getPayment(payment.id)?.state).toBe('CAPTURED');
  });
});