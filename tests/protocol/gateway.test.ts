// tests/protocol/gateway.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCart, createStandardMandate, createTestApp, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

describe('protocol gateway (§36, §69 protocol list)', () => {
  it('submissions flow through the AuthorizationEngine and are recorded as protocol requests', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const result = await t.ctx.gateway.submitPayload(
      { type: 'cart.create', items: [{ productId: 'shoe-001', quantity: 1 }] },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'MCP' },
      { execute: false },
    );
    expect(result.decision).toBe('ALLOW');
    expect(result.decisionId).not.toBeNull();
    const decision = t.ctx.authorization.getDecision(result.decisionId ?? '');
    expect(decision?.protocol).toBe('MCP');

    const own = t.ctx.gateway
      .listProtocolRequests(50)
      .find((r) => r.id === result.protocolRequestId);
    expect(own?.tool).toBe('create_cart');
    expect(own?.decision).toBe('ALLOW');
  });

  it('an unknown capability fails closed at the protocol boundary', async () => {
    const result = await t.ctx.gateway.submitPayload(
      { type: 'catalog.read', query: 'running' },
      { agentId: 'buyer-agent-01', mandateId: null, protocol: 'MCP', requestedCapabilities: ['root.access'] },
      { execute: false },
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('CAPABILITY_UNKNOWN');
  });

  it('privileged actions never pass the protocol boundary', async () => {
    const result = await t.ctx.gateway.submitPayload(
      { type: 'refund.create', paymentId: 'pay_x', amountPaise: 100_000 },
      { agentId: 'buyer-agent-01', mandateId: null, protocol: 'MCP' },
      { execute: false },
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('CAPABILITY_PRIVILEGED');
    expect(result.executed).toBe(false);
  });

  it('payment without valid authorization is blocked (claimed amount must match the cart)', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const result = await t.ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: cart.id, amountPaise: 1, discountPaise: 0 },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'MCP' },
      { execute: true },
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('PRICE_TAMPER');
    expect(t.ctx.payments.listPayments(10)).toHaveLength(0);
  });

  it('denied tools are persisted as DENIED protocol requests', () => {
    const note = t.ctx.gateway.noteDeniedTool('refund', 'buyer-agent-01', 'test denial');
    expect(note.status).toBe('DENIED');
    expect(note.tool).toBe('refund');
  });
});