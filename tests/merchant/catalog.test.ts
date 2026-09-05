// tests/merchant/catalog.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR_IDS, formatINR, rupeesToPaise } from '@acsf/shared';
import { IntentService } from '../../apps/api/src/services/IntentService';
import { createCart, createStandardMandate, createTestApp, payCart, type TestApp } from '../helpers/testApp';

const MERCHANT = 'demo-merchant-admin';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

function addBottle(price = 899): string {
  return t.ctx.catalogAdmin.createProduct(
    {
      sku: 'MER-BOT-001',
      name: 'Merchant Trail Bottle',
      description: 'A bottle the merchant added themselves.',
      priceRupees: price,
      category: 'sports',
      marginPercent: 55,
      active: true,
    },
    MERCHANT,
  ).id;
}

describe('merchant catalog administration (§18)', () => {
  it('the merchant can add a product agents immediately discover', () => {
    const id = addBottle();
    const product = t.ctx.catalog.getProduct(id);

    expect(product?.name).toBe('Merchant Trail Bottle');
    expect(product?.pricePaise).toBe(rupeesToPaise(899));
    expect(t.ctx.catalog.searchProducts('bottle').some((p) => p.id === id)).toBe(true);
  });

  it('a merchant price change is what the firewall actually charges', async () => {
    const id = addBottle(899);
    t.ctx.catalogAdmin.updateProduct(id, { priceRupees: 1_250 }, MERCHANT);

    const mandateId = createStandardMandate(t.ctx, { allowedCategories: ['sports'] });
    const cart = await createCart(t.ctx, ACTOR_IDS.buyerAgentId, mandateId, [
      { productId: id, quantity: 1 },
    ]);

    expect(cart.subtotalPaise).toBe(rupeesToPaise(1_250));
  });

  it('a merchant-authored product cannot be flagged as the injection demo', () => {
    const id = addBottle();
    expect(t.ctx.catalog.getProduct(id)?.malicious).toBe(false);
  });

  it('rejects a duplicate SKU rather than shadowing an existing product', () => {
    addBottle();
    expect(() =>
      t.ctx.catalogAdmin.createProduct(
        {
          sku: 'MER-BOT-001',
          name: 'Another Bottle',
          description: '',
          priceRupees: 500,
          category: 'sports',
          marginPercent: 30,
          active: true,
        },
        MERCHANT,
      ),
    ).toThrow(/already used/i);
  });

  it('deactivating removes a product from what an agent may buy', async () => {
    const id = addBottle();
    t.ctx.catalogAdmin.updateProduct(id, { active: false }, MERCHANT);

    const mandateId = createStandardMandate(t.ctx, { allowedCategories: ['sports'] });
    const result = await t.ctx.gateway.submitPayload(
      { type: 'cart.create', items: [{ productId: id, quantity: 1 }] },
      { agentId: ACTOR_IDS.buyerAgentId, mandateId, protocol: 'INTERNAL' },
      { execute: true },
    );

    expect(result.decision).toBe('BLOCK');
    expect(result.violations.map((v) => v.code)).toContain('PRODUCT_INACTIVE');
  });
});

describe('agents can never write the catalog', () => {
  it('refuses every mutation when the actor is a registered agent', () => {
    const id = addBottle();

    for (const agentId of [
      ACTOR_IDS.buyerAgentId,
      ACTOR_IDS.growthAgentId,
      ACTOR_IDS.adversarialAgentId,
    ]) {
      expect(() =>
        t.ctx.catalogAdmin.updateProduct(id, { priceRupees: 1 }, agentId),
      ).toThrow(/is an agent/i);
      expect(() => t.ctx.catalogAdmin.deleteProduct(id, agentId)).toThrow(/is an agent/i);
      expect(() => t.ctx.catalogAdmin.restoreDemoCatalog(agentId)).toThrow(/is an agent/i);
      expect(() =>
        t.ctx.catalogAdmin.createProduct(
          {
            sku: 'AGENT-001',
            name: 'Agent Self Service',
            description: '',
            priceRupees: 1,
            category: 'sports',
            marginPercent: 99,
            active: true,
          },
          agentId,
        ),
      ).toThrow(/is an agent/i);
    }

    // The price the agent tried to set never landed.
    expect(t.ctx.catalog.getProduct(id)?.pricePaise).toBe(rupeesToPaise(899));
  });

  it('exposes no catalog write through the protocol layer', async () => {
    const tools = t.ctx.adapter.listTools().map((tool) => tool.name);
    expect(tools.some((name) => /product|catalog/.test(name) && /create|update|delete|write/.test(name))).toBe(
      false,
    );
  });
});

describe('history is never rewritten to suit a catalog edit', () => {
  it('refuses to delete a product that appears in an order, but allows deactivation', async () => {
    const id = addBottle();
    const mandateId = createStandardMandate(t.ctx, { allowedCategories: ['sports'] });
    const cart = await createCart(t.ctx, ACTOR_IDS.buyerAgentId, mandateId, [
      { productId: id, quantity: 1 },
    ]);
    const payment = await payCart(t.ctx, ACTOR_IDS.buyerAgentId, mandateId, cart.id);
    expect(payment.state).toBe('CAPTURED');

    expect(() => t.ctx.catalogAdmin.deleteProduct(id, MERCHANT)).toThrow(/deactivate it instead/i);
    expect(t.ctx.catalog.getProduct(id)).not.toBeNull();

    const deactivated = t.ctx.catalogAdmin.updateProduct(id, { active: false }, MERCHANT);
    expect(deactivated.active).toBe(false);
  });

  it('deletes an unused product cleanly', () => {
    const id = addBottle();
    expect(t.ctx.catalogAdmin.deleteProduct(id, MERCHANT).deleted).toBe(true);
    expect(t.ctx.catalog.getProduct(id)).toBeNull();
  });

  it('audits every catalog change onto the same hash chain', () => {
    const id = addBottle();
    t.ctx.catalogAdmin.updateProduct(id, { priceRupees: 1_000 }, MERCHANT);

    const events = t.ctx.audit.list({ eventType: 'CATALOG_CHANGE', limit: 50 });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.actor === MERCHANT)).toBe(true);
    expect(t.ctx.audit.verifyChain().valid).toBe(true);
  });
});

describe('RESET DEMO preserves the merchant, wipes the transactions', () => {
  it('keeps merchant products and policy while clearing orders and mandates', async () => {
    const id = addBottle();
    t.ctx.policies.updatePolicy(t.ctx.merchantId, { maxDiscountRupees: 250 }, MERCHANT);

    const before = await t.ctx.demo.start();
    expect(before.reset.historyOrders).toBe(21);

    const after = await t.ctx.demo.reset();

    // The merchant's own product and their policy edit both survived.
    expect(t.ctx.catalog.getProduct(id)?.name).toBe('Merchant Trail Bottle');
    expect(t.ctx.policies.getActivePolicy(t.ctx.merchantId)?.maxDiscountPaise).toBe(rupeesToPaise(250));

    // Only the regenerated history remains; nothing from the earlier run.
    expect(after.historyOrders).toBe(21);
    expect(t.ctx.mandates.getActiveMandateForUser(ACTOR_IDS.userId)?.row.id).toBe(after.mandateId);
  });

  it('restores the shipped catalog on demand, keeping products that appear in history', async () => {
    const id = addBottle();
    t.ctx.catalogAdmin.updateProduct('shoe-001', { priceRupees: 99, name: 'Clearance Shoes' }, MERCHANT);

    const result = t.ctx.catalogAdmin.restoreDemoCatalog(MERCHANT);

    const shoe = t.ctx.catalog.getProduct('shoe-001');
    expect(shoe?.name).toBe('Marathon Running Shoes');
    expect(formatINR(shoe?.pricePaise ?? 0)).toBe(formatINR(rupeesToPaise(7_499)));
    // The unused merchant product was removed rather than left half-alive.
    expect(t.ctx.catalog.getProduct(id)).toBeNull();
    expect(result.removed).toBe(1);
  });
});

describe('intent planning follows the merchant catalog', () => {
  it('plans against a product the merchant added', async () => {
    addBottle(899);
    const report = await new IntentService(t.ctx).plan('I need a trail bottle for the gym under ₹1,000');

    expect(report.plan.allowedCategories).toContain('sports');
    expect(report.plan.matches.some((m) => m.name === 'Merchant Trail Bottle')).toBe(true);
  });

  it('stops matching a product the merchant deactivated', async () => {
    t.ctx.catalogAdmin.updateProduct('shoe-001', { active: false }, MERCHANT);
    t.ctx.catalogAdmin.updateProduct('malicious-001', { active: false }, MERCHANT);

    const report = await new IntentService(t.ctx).plan('I need running shoes for my marathon under ₹8,000');

    expect(report.plan.allowedCategories).toEqual(['running_shoes']);
    expect(report.plan.matches).toEqual([]);
    expect(report.plan.anchorProductId).toBeNull();
  });
});
