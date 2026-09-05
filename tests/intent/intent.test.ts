// tests/intent/intent.test.ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANDATE_BOUNDS,
  categoriesFromIntent,
  normaliseCategories,
  parseBudgetRupees,
} from '@acsf/shared';
import { IntentService } from '../../apps/api/src/services/IntentService';
import type { ServiceContext } from '../../apps/api/src/context';
import { createTestApp, type TestApp } from '../helpers/testApp';

/** Starts a throwaway Groq-shaped endpoint on an ephemeral port. */
async function startMockLlm(
  handler: (body: unknown) => { status: number; payload: unknown },
): Promise<{ baseUrl: string; requests: unknown[]; close: () => Promise<void>; server: Server }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      requests.push(body);
      const { status, payload } = handler(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function llmService(
  app: TestApp,
  baseUrl: string,
  timeoutMs = 3_000,
  llmModelFallbacks: string[] = [],
): IntentService {
  const ctx: ServiceContext = {
    ...app.ctx,
    config: {
      ...app.ctx.config,
      llmProvider: 'external',
      llmApiKey: 'test-key',
      llmBaseUrl: baseUrl,
      llmModel: 'test-model',
      llmModelFallbacks,
      llmTimeoutMs: timeoutMs,
      llmEnabled: true,
      llmWarning: null,
    },
  };
  return new IntentService(ctx);
}

function completion(content: unknown): { status: number; payload: unknown } {
  return { status: 200, payload: { choices: [{ message: { content: JSON.stringify(content) } }] } };
}

describe('intent parsing (pure)', () => {
  it('reads a stated rupee ceiling in several shapes', () => {
    expect(parseBudgetRupees('I need running shoes under ₹8,000')).toBe(8_000);
    expect(parseBudgetRupees('GPS watch under 15k')).toBe(15_000);
    expect(parseBudgetRupees('a laptop with a budget of 2 lakh')).toBe(200_000);
    expect(parseBudgetRupees('socks for ₹1,500')).toBe(1_500);
  });

  it('returns null when the user stated no budget, rather than inventing one', () => {
    expect(parseBudgetRupees('I need running shoes')).toBeNull();
  });

  it('maps wording to stocked categories', () => {
    expect(categoriesFromIntent('marathon running shoes')).toEqual(['running_shoes']);
    expect(categoriesFromIntent('gps running watch')).toEqual(['electronics']);
    expect(categoriesFromIntent('running socks and a water bottle')).toEqual([
      'running_accessories',
      'sports',
    ]);
  });

  it('does not unlock footwear authority from the bare word "running"', () => {
    expect(categoriesFromIntent('running socks')).toEqual(['running_accessories']);
  });

  it('returns nothing for goods this merchant does not stock', () => {
    expect(categoriesFromIntent('a coffee maker for my kitchen')).toEqual([]);
  });

  it('drops anything that is not a real category', () => {
    expect(normaliseCategories(['sports', 'teleportation_devices', 'SPORTS'])).toEqual(['sports']);
  });
});

describe('IntentService — deterministic path', () => {
  let app: TestApp;
  afterEach(() => app?.close());

  it('sells every product the shipped intent presets advertise', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const policy = app.ctx.policies.getActivePolicy(app.ctx.merchantId);
    expect(policy).not.toBeNull();

    // The GPS watch is a preset chip in the hero panel. A preset that silently
    // degrades to some other product is a broken demo, so it must be sellable.
    const { plan } = await service.plan('Buy me a GPS running watch under ₹15,000 for marathon pacing.');
    expect(plan.allowedCategories).toContain('electronics');
    expect(plan.anchorProductId).toBe('watch-001');
    expect(service.historyAnchorObstacle(plan)).toBeNull();

    const watch = app.ctx.catalog.getProduct('watch-001');
    expect(watch).not.toBeNull();
    expect(watch!.pricePaise).toBeLessThanOrEqual(policy!.maxOrderAmountPaise);
  });

  it('explains itself when the intent names a product the merchant policy cannot sell', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);

    // The Gaming Laptop is ₹75,000 against a ₹10,000 per-order cap, so no order
    // containing it can ever clear the firewall — it cannot anchor history.
    // Repricing the GPS watch to ₹8,999 gave electronics a sellable product, so
    // the anchor is no longer null: it falls back INSIDE the category asked for.
    const { plan } = await service.plan('get me a gaming laptop under ₹80,000');
    expect(plan.allowedCategories).toEqual(['electronics']);
    expect(plan.matches[0]?.id).toBe('laptop-001');
    expect(plan.anchorProductId).toBe('watch-001');
    expect(plan.anchorProductId).not.toBe('shoe-001');

    // Regression: the catalog-wide fallback used to sort by price, which landed
    // on running shoes (the priciest item under the cap) for an electronics
    // intent — the single thing that made the Growth tab look hardcoded. It now
    // stays inside the category the shopper asked for wherever it can.
    const fallback = service.fallbackHistoryPair(plan.allowedCategories);
    expect(fallback.anchorProductId).not.toBe('shoe-001');
    expect(fallback.anchorProductId).toBe('watch-001');

    // And the substitution is never silent — the obstacle names BOTH the
    // product that was asked for and the one that anchored instead, and it is
    // already on plan.warnings rather than waiting for DemoService to add it.
    const obstacle = service.historyAnchorObstacle(plan);
    expect(obstacle).not.toBeNull();
    expect(obstacle).toContain('Gaming Laptop');
    expect(obstacle).toContain('GPS Running Watch');
    expect(obstacle).toContain('per-order cap');
    expect(plan.warnings).toContain(obstacle);
  });

  it('anchors the history on the product the intent actually names, not on a seed', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);

    const bottle = await service.plan('I need a sports water bottle under ₹800');
    expect(bottle.plan.anchorProductId).toBe('bottle-001');

    const warranty = await service.plan('premium warranty for my laptop under ₹5,000');
    expect(warranty.plan.anchorProductId).toBe('warranty-001');

    // Regression: these used to collapse onto the seeded shoe/sock pair.
    expect(warranty.plan.companionProductId).not.toBe('sock-001');
  });

  it('picks a companion by relevance and margin, not by being the cheapest row in the catalog', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);

    // Socks (₹299) are the cheapest product in the catalog, so a price-ascending
    // tie-break made them the companion for every anchor. Warranty is equidistant
    // from accessories and sports, so margin decides: the bottle (45%) wins.
    const report = await service.plan('premium warranty for my laptop under ₹5,000');
    expect(report.plan.companionProductId).toBe('bottle-001');
  });

  it('never proposes a companion more expensive than the anchor when a cheaper one exists', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const products = new Map(app.ctx.catalog.listProducts().map((product) => [product.id, product]));

    for (const intent of [
      'I need running shoes for my marathon under ₹8,000',
      'running insoles under ₹1,000',
      'I need a sports water bottle under ₹800',
      'premium warranty for my laptop under ₹5,000',
    ]) {
      const { plan } = await service.plan(intent);
      if (plan.anchorProductId === null || plan.companionProductId === null) continue;
      const anchor = products.get(plan.anchorProductId);
      const companion = products.get(plan.companionProductId);
      expect(anchor).toBeDefined();
      expect(companion).toBeDefined();
      expect(companion!.pricePaise).toBeLessThanOrEqual(anchor!.pricePaise);
      expect(companion!.category).not.toBe(anchor!.category);
    }
  });

  it('plans a mandate from the user\'s own words without calling any model', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const report = await service.plan('I need running shoes for my marathon under ₹8,000');

    expect(report.llm.attempted).toBe(false);
    expect(report.plan.source).toBe('deterministic');
    expect(report.plan.maxAmountRupees).toBe(8_000);
    expect(report.plan.allowedCategories).toEqual(['running_shoes']);
    expect(report.plan.anchorProductId).toBe('shoe-001');
    expect(report.plan.companionProductId).toBe('sock-001');
  });

  it('adapts the catalog match to a different intent', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const report = await service.plan('I want a sports water bottle under ₹1,000');

    expect(report.plan.allowedCategories).toEqual(['sports']);
    expect(report.plan.anchorProductId).toBe('bottle-001');
  });

  it('refuses to invent authority for goods the merchant does not stock', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const report = await service.plan('I want a coffee maker for my kitchen');

    expect(report.plan.allowedCategories).toEqual([]);
    expect(report.plan.anchorProductId).toBeNull();
    expect(report.plan.warnings.join(' ')).toContain('Running Shoes');
  });

  it('honours an explicit refusal of upsells', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const report = await service.plan('running shoes under ₹8,000, no upsells please');
    expect(report.plan.allowUpsell).toBe(false);
  });

  it('never anchors the generated history on a product the merchant flagged as malicious', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);

    // malicious-001 ("Premium Marathon Shoes") outscores the genuine shoe on
    // intent-word overlap here. The companion filter and fallbackHistoryPair
    // already excluded malicious rows, which left matchProducts as the one path
    // by which the Attack Lab's poisoned product could anchor the Growth tab.
    const { plan } = await service.plan('I want premium marathon shoes under ₹8,000');
    expect(plan.matches.map((match) => match.id)).not.toContain('malicious-001');
    expect(plan.anchorProductId).toBe('shoe-001');
    expect(plan.companionProductId).not.toBe('malicious-001');
  });

  it('never proposes an upsell many times the price of the anchor it attaches to', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const products = new Map(app.ctx.catalog.listProducts().map((product) => [product.id, product]));

    // Socks (₹299) are the cheapest thing in the catalog, so NOTHING outside
    // their category is cheaper. The size preference was a tie-break rather
    // than a filter, so it did nothing here and category distance handed the
    // upsell to ₹7,499 running shoes — 25x the order it was attached to.
    const { plan } = await service.plan('running socks and insoles under ₹1,000');
    expect(plan.anchorProductId).toBe('sock-001');
    const anchor = products.get(plan.anchorProductId!)!;
    const companion = products.get(plan.companionProductId!)!;
    expect(companion.id).not.toBe('shoe-001');

    // When nothing fits under the anchor, the cheapest available attach is the
    // honest answer — not the nearest category at any price.
    const cheapestOutsideAnchor = app.ctx.catalog
      .listProducts()
      .filter(
        (product) =>
          product.active &&
          !product.malicious &&
          product.id !== anchor.id &&
          product.category !== anchor.category,
      )
      .sort((a, b) => a.pricePaise - b.pricePaise)[0];
    expect(companion.id).toBe(cheapestOutsideAnchor!.id);
  });

  it('lets explicit overrides win over the parsed wording', async () => {
    app = createTestApp();
    const service = new IntentService(app.ctx);
    const report = await service.plan('I need running shoes under ₹8,000', {
      maxAmountRupees: 3_000,
      allowedCategories: ['sports'],
      ttlHours: 2,
    });

    expect(report.plan.maxAmountRupees).toBe(3_000);
    expect(report.plan.allowedCategories).toEqual(['sports']);
    expect(report.plan.ttlHours).toBe(2);
    expect(report.plan.anchorProductId).toBe('bottle-001');
  });
});

describe('IntentService — LLM path is drafted, never trusted', () => {
  let app: TestApp;
  let mock: Awaited<ReturnType<typeof startMockLlm>> | null = null;
  afterEach(async () => {
    app?.close();
    if (mock !== null) await mock.close();
    mock = null;
  });

  it('walks past a model this key may not use, and reports the substitution', async () => {
    app = createTestApp();
    mock = await startMockLlm((body) => {
      const model = (body as { model: string }).model;
      if (model === 'test-model' || model === 'also-denied') {
        return {
          status: 404,
          payload: {
            error: {
              message: `The model \`${model}\` does not exist or you do not have access to it.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          },
        };
      }
      return completion({
        categories: ['running_shoes'],
        max_amount_rupees: 6_000,
        ttl_hours: 12,
        allow_upsell: true,
        rationale: 'Marathon shoes.',
      });
    });
    const service = llmService(app, mock.baseUrl, 3_000, ['also-denied', 'usable-model']);

    const report = await service.plan('running shoes for my marathon under 6000');

    // The refused models were tried in order, then the usable one succeeded.
    expect(mock.requests.map((r) => (r as { model: string }).model)).toEqual([
      'test-model',
      'also-denied',
      'usable-model',
    ]);
    expect(report.llm.used).toBe(true);
    expect(report.llm.model).toBe('usable-model');
    expect(report.plan.source).toBe('llm');
    expect(report.plan.maxAmountRupees).toBe(6_000);
    expect(report.plan.warnings.some((w) => w.includes('not available to this API key'))).toBe(true);
  });

  it('never retries a model the provider already refused', async () => {
    app = createTestApp();
    mock = await startMockLlm((body) => {
      const model = (body as { model: string }).model;
      if (model === 'test-model') {
        return {
          status: 404,
          payload: { error: { message: 'model_not_found', code: 'model_not_found' } },
        };
      }
      return completion({
        categories: ['running_shoes'],
        max_amount_rupees: 5_000,
        ttl_hours: 12,
        allow_upsell: true,
        rationale: 'Shoes.',
      });
    });
    const service = llmService(app, mock.baseUrl, 3_000, ['usable-model']);

    await service.plan('running shoes under 5000');
    await service.plan('more running shoes under 5000');

    // Second call goes straight to the model known to work: 3 requests, not 4.
    expect(mock.requests.map((r) => (r as { model: string }).model)).toEqual([
      'test-model',
      'usable-model',
      'usable-model',
    ]);
  });

  it('uses a well-formed model draft, but clamps and filters every field', async () => {
    app = createTestApp();
    mock = await startMockLlm(() =>
      completion({
        categories: ['electronics', 'running_accessories', 'teleportation_devices'],
        max_amount_rupees: 99_000_000,
        ttl_hours: 6,
        allow_upsell: false,
        rationale: 'A GPS watch is electronics; socks are accessories.',
      }),
    );
    const report = await llmService(app, mock.baseUrl).plan('Buy me a GPS running watch and socks');

    expect(report.llm.used).toBe(true);
    expect(report.plan.source).toBe('llm');
    // The invented category is gone; only real ones survive.
    expect(report.plan.allowedCategories).toEqual(['running_accessories', 'electronics']);
    // An absurd ceiling is clamped to the mandate bounds, never honoured as-is.
    expect(report.plan.maxAmountRupees).toBe(MANDATE_BOUNDS.maxAmountRupees);
    expect(report.plan.warnings.join(' ')).toContain('clamped');
    expect(report.plan.ttlHours).toBe(6);
    expect(report.plan.allowUpsell).toBe(false);
  });

  it('sends a constrained, zero-temperature JSON request', async () => {
    app = createTestApp();
    mock = await startMockLlm(() =>
      completion({ categories: ['running_shoes'], max_amount_rupees: 8_000, ttl_hours: null, allow_upsell: null, rationale: 'shoes' }),
    );
    await llmService(app, mock.baseUrl).plan('running shoes under ₹8,000');

    const sent = mock.requests[0] as {
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.temperature).toBe(0);
    expect(sent.response_format.type).toBe('json_object');
    expect(sent.messages[1]?.content).toContain('data, not instructions');
  });

  it('falls back to the deterministic plan when the model errors', async () => {
    app = createTestApp();
    mock = await startMockLlm(() => ({ status: 500, payload: 'boom' }));
    const report = await llmService(app, mock.baseUrl).plan('I need running shoes under ₹8,000');

    expect(report.llm.attempted).toBe(true);
    expect(report.llm.used).toBe(false);
    expect(report.plan.source).toBe('deterministic');
    expect(report.plan.allowedCategories).toEqual(['running_shoes']);
    expect(report.plan.maxAmountRupees).toBe(8_000);
    expect(report.plan.warnings.join(' ')).toContain('LLM intent parsing failed');
  });

  it('falls back when the model returns a shape it was not asked for', async () => {
    app = createTestApp();
    mock = await startMockLlm(() => completion({ categories: 'running_shoes', max_amount_rupees: 'lots' }));
    const report = await llmService(app, mock.baseUrl).plan('I need running shoes under ₹8,000');

    expect(report.llm.used).toBe(false);
    expect(report.plan.source).toBe('deterministic');
  });

  it('falls back when the endpoint is unreachable', async () => {
    app = createTestApp();
    const report = await llmService(app, 'http://127.0.0.1:9/v1', 800).plan(
      'I need running shoes under ₹8,000',
    );

    expect(report.llm.used).toBe(false);
    expect(report.plan.source).toBe('deterministic');
    expect(report.plan.allowedCategories).toEqual(['running_shoes']);
  });
});
