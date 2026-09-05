import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalCartItem } from '../../apps/api/src/services/CartIntegrityService';
import { createCart, createStandardMandate, createTestApp, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

describe('cart integrity canonical hashing (§25, §69)', () => {
  const items: CanonicalCartItem[] = [
    { productId: 'b-001', quantity: 1, unitPricePaise: 200, options: { size: 'm', color: 'red' } },
    { productId: 'a-001', quantity: 2, unitPricePaise: 100, options: {} },
  ];

  it('the same canonical cart → the same hash regardless of item or key order', () => {
    const h1 = t.ctx.cartIntegrity.computeHash(items, 0);
    expect(t.ctx.cartIntegrity.computeHash([...items].reverse(), 0)).toBe(h1);
    const reorderedOptionKeys: CanonicalCartItem[] = [
      { productId: 'a-001', quantity: 2, unitPricePaise: 100, options: {} },
      { productId: 'b-001', quantity: 1, unitPricePaise: 200, options: { color: 'red', size: 'm' } },
    ];
    expect(t.ctx.cartIntegrity.computeHash(reorderedOptionKeys, 0)).toBe(h1);
  });

  it('a different quantity → a different hash', () => {
    const h1 = t.ctx.cartIntegrity.computeHash(items, 0);
    const changed: CanonicalCartItem[] = items.map((i) => (i.productId === 'a-001' ? { ...i, quantity: 3 } : i));
    expect(t.ctx.cartIntegrity.computeHash(changed, 0)).not.toBe(h1);
  });

  it('a different price → a different hash', () => {
    const h1 = t.ctx.cartIntegrity.computeHash(items, 0);
    const changed: CanonicalCartItem[] = items.map((i) => (i.productId === 'a-001' ? { ...i, unitPricePaise: 101 } : i));
    expect(t.ctx.cartIntegrity.computeHash(changed, 0)).not.toBe(h1);
  });

  it('an added item → a different hash', () => {
    const h1 = t.ctx.cartIntegrity.computeHash(items, 0);
    const withExtra: CanonicalCartItem[] = [...items, { productId: 'c-001', quantity: 1, unitPricePaise: 50, options: {} }];
    expect(t.ctx.cartIntegrity.computeHash(withExtra, 0)).not.toBe(h1);
  });

  it('a different discount → a different hash', () => {
    const h1 = t.ctx.cartIntegrity.computeHash(items, 0);
    expect(t.ctx.cartIntegrity.computeHash(items, 500)).not.toBe(h1);
  });

  it('live carts: the stored hash always reflects current database state', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const before = t.ctx.carts.getCart(cart.id);
    expect(before?.cart.currentHash).toBe(t.ctx.cartIntegrity.hashForCart(cart.id));

    await t.ctx.gateway.submitPayload(
      { type: 'cart.add_item', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }] },
      { agentId: 'buyer-agent-01', mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );
    const after = t.ctx.carts.getCart(cart.id);
    expect(after?.cart.currentHash).not.toBe(before?.cart.currentHash);
    expect(after?.cart.currentHash).toBe(t.ctx.cartIntegrity.hashForCart(cart.id));
  });
});