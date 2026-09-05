// tests/audit/auditChain.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../apps/api/src/db/schema';
import { createCart, createStandardMandate, createTestApp, payCart, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

function orderedRows() {
  return t.ctx.db.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.sequence)).all();
}

describe('audit hash chain (§44, §69 audit list)', () => {
  it('events are generated with contiguous sequences and linked hashes', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);

    const rows = orderedRows();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]?.previousEventHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.sequence).toBe((rows[i - 1]?.sequence ?? 0) + 1);
      expect(rows[i]?.previousEventHash).toBe(rows[i - 1]?.eventHash);
    }
    const status = t.ctx.audit.verifyChain();
    expect(status.valid).toBe(true);
    expect(status.eventCount).toBe(rows.length);
  });

  it('tampering with an event body is detected', async () => {
    const mandateId = createStandardMandate(t.ctx);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const rows = orderedRows();
    const victim = rows[2];
    expect(victim).toBeDefined();

    t.ctx.db
      .update(schema.auditEvents)
      .set({ reason: 'tampered reason' })
      .where(eq(schema.auditEvents.eventId, victim?.eventId ?? ''))
      .run();

    const status = t.ctx.audit.verifyChain();
    expect(status.valid).toBe(false);
    expect(status.firstInvalidSequence).toBe(victim?.sequence ?? null);
  });

  it('deleting an event (sequence gap) is detected', async () => {
    const mandateId = createStandardMandate(t.ctx);
    await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const rows = orderedRows();
    t.ctx.db
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.eventId, rows[1]?.eventId ?? ''))
      .run();
    const status = t.ctx.audit.verifyChain();
    expect(status.valid).toBe(false);
    expect(status.message).toContain('expected sequence');
  });

  it('policy changes append events without rewriting any history', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    await payCart(t.ctx, 'buyer-agent-01', mandateId, cart.id);
    const before = orderedRows();

    t.ctx.policies.updatePolicy(t.ctx.merchantId, { maxDiscountRupees: 1_000 }, 'test-user');

    const after = orderedRows();
    expect(after.length).toBe(before.length + 1);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]?.eventHash).toBe(before[i]?.eventHash);
    }
    expect(t.ctx.audit.verifyChain().valid).toBe(true);
  });
});