// tests/payments/states.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { canTransition } from '@acsf/shared';
import * as schema from '../../apps/api/src/db/schema';
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

describe('payment state machine (§27, §69)', () => {
  it('defines the legal transition matrix', () => {
    expect(canTransition('CREATED', 'PENDING')).toBe(true);
    expect(canTransition('PENDING', 'AUTHORIZED')).toBe(true);
    expect(canTransition('PENDING', 'CAPTURED')).toBe(true);
    expect(canTransition('PENDING', 'UNKNOWN')).toBe(true);
    expect(canTransition('UNKNOWN', 'CAPTURED')).toBe(true);
    expect(canTransition('UNKNOWN', 'FAILED')).toBe(true);
    expect(canTransition('AUTHORIZED', 'CAPTURED')).toBe(true);
    expect(canTransition('CAPTURED', 'REFUNDED')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('CREATED', 'CAPTURED')).toBe(false);
    expect(canTransition('CAPTURED', 'PENDING')).toBe(false);
    expect(canTransition('FAILED', 'CAPTURED')).toBe(false);
    expect(canTransition('REFUNDED', 'CAPTURED')).toBe(false);
    expect(canTransition('CANCELLED', 'AUTHORIZED')).toBe(false);
  });

  it('success: CREATED → PENDING → AUTHORIZED → CAPTURED; order completed; cart paid', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [
      { productId: 'shoe-001', quantity: 1 },
      { productId: 'sock-001', quantity: 1 },
    ]);
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('CAPTURED');
    expect(payment.timeline.map((e) => e.event)).toEqual([
      'provider.requested',
      'provider.authorized',
      'provider.capture',
    ]);
    expect(payment.orderId).not.toBeNull();
    const order = t.ctx.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, payment.orderId ?? ''))
      .get();
    expect(order?.status).toBe('completed');
    expect(t.ctx.carts.getCart(cart.id)?.cart.state).toBe('paid');
    expect(t.ctx.payments.getRevenueCapturedPaise()).toBe(779_800);
  });

  it('provider timeout → UNKNOWN', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    mockProvider(t.ctx).arm('timeout_then_captured');
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(payment.state).toBe('UNKNOWN');
    expect(payment.timeline.some((e) => e.event === 'provider.timeout')).toBe(true);
  });

  it('illegal runtime transitions throw and never mutate state', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const payment = await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    expect(() => t.ctx.payments.transition(payment.id, 'PENDING', 'test.illegal', 'illegal')).toThrow(
      /not a legal payment transition/,
    );
    expect(t.ctx.payments.getPayment(payment.id)?.state).toBe('CAPTURED');
  });
});