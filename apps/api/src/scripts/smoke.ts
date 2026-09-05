// apps/api/src/scripts/smoke.ts
/**
 * End-to-end engine smoke test against an in-memory database:
 * mandate → cart.create → upsell (growth) → payment.create → attack attempts.
 * Run: npm run smoke
 */
import { ACTOR_IDS, DEMO_INTENT, type CartCreateAction, type PaymentCreateAction, type UpsellCreateAction } from '@acsf/shared';
import { createDatabase } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedDatabase } from '../db/seed';
import { buildServiceContext } from '../context';
import { SystemClock } from '../utils/clock';

function heading(label: string): void {
  console.log(`\n━━━ ${label} ${'━'.repeat(Math.max(0, 60 - label.length))}`);
}

function main(): void {
  const handle = createDatabase(':memory:');
  const clock = new SystemClock();
  runMigrations(handle.sqlite);
  seedDatabase(handle.db, clock);
  const ctx = buildServiceContext(handle, clock, {
    nodeEnv: 'development',
    apiPort: 3001,
    webPort: 5173,
    databaseUrl: ':memory:',
    paymentProvider: 'mock',
    razorpayKeyId: null,
    razorpayKeySecret: null,
    paymentProviderWarning: null,
    llmProvider: 'deterministic',
    llmApiKey: null,
    llmBaseUrl: 'https://api.groq.com/openai/v1',
    llmModel: 'llama-3.3-70b-versatile',
    llmModelFallbacks: [],
    llmTimeoutMs: 8_000,
    llmEnabled: false,
    llmWarning: null,
    mcpPort: 3002,
  });

  let pass = 0;
  let fail = 0;
  function expect(label: string, actual: string, expected: string): void {
    const okFlag = actual === expected;
    if (okFlag) pass += 1;
    else fail += 1;
    console.log(`${okFlag ? '  ✔' : '  ✘'} ${label}: ${actual}${okFlag ? '' : ` (expected ${expected})`}`);
  }

  heading('USER MANDATE');
  const mandate = ctx.mandates.createMandate(
    {
      userId: 'demo-user',
      intent: DEMO_INTENT,
      maxAmountRupees: 8000,
      allowedCategories: ['running_shoes'],
      allowUpsell: true,
      ttlHours: 24,
    },
    'demo-user',
  );
  console.log(`  mandate ${mandate.row.id} v${mandate.row.version} — "${mandate.row.intent}"`);

  heading('DISCOVERY (catalog.read)');
  const search = ctx.authorization.evaluateAction({
    actionId: 'smoke-discovery',
    type: 'catalog.read',
    agentId: ACTOR_IDS.buyerAgentId,
    mandateId: mandate.row.id,
    cartId: null,
    protocol: 'REST',
    requestedCapabilities: ['catalog.read'],
    timestamp: clock.now().toISOString(),
    idempotencyKey: 'smoke-discovery-1',
    query: 'running shoes',
  });
  expect('search decision', search.decision, 'ALLOW');

  heading('BUYER CREATES CART (Marathon Running Shoes ₹7,499)');
  const createAction: CartCreateAction = {
    actionId: 'smoke-cart-create',
    type: 'cart.create',
    agentId: ACTOR_IDS.buyerAgentId,
    mandateId: mandate.row.id,
    cartId: null,
    protocol: 'REST',
    requestedCapabilities: ['cart.create'],
    timestamp: clock.now().toISOString(),
    idempotencyKey: 'smoke-cart-create-1',
    items: [{ productId: 'shoe-001', quantity: 1 }],
  };
  const createResult = ctx.authorization.evaluateAction(createAction);
  expect('cart.create decision', createResult.decision, 'ALLOW');
  const cart = ctx.carts.createCart({
    mandateId: mandate.row.id,
    agentId: ACTOR_IDS.buyerAgentId,
    protocol: 'REST',
    items: createResult.itemsToApply ?? [],
    source: 'buyer',
    decisionId: createResult.decisionId,
  });
  console.log(`  cart ${cart.cart.id} — subtotal ₹${(cart.subtotalPaise / 100).toLocaleString('en-IN')}`);

  heading('GROWTH AGENT PROPOSES UPSELL (Performance Running Socks ₹299)');
  const upsellAction: UpsellCreateAction = {
    actionId: 'smoke-upsell',
    type: 'upsell.create',
    agentId: ACTOR_IDS.growthAgentId,
    mandateId: mandate.row.id,
    cartId: cart.cart.id,
    protocol: 'REST',
    requestedCapabilities: ['upsell.create'],
    timestamp: clock.now().toISOString(),
    idempotencyKey: 'smoke-upsell-1',
    items: [{ productId: 'sock-001', quantity: 1 }],
    pitch: 'High co-purchase rate with running shoes',
  };
  const upsellResult = ctx.authorization.evaluateAction(upsellAction);
  expect('upsell decision', upsellResult.decision, 'ALLOW');
  console.log(`  drift (growth session): ${upsellResult.drift?.overall ?? 'n/a'}`);
  const updatedCart = ctx.carts.addItems(cart.cart.id, upsellResult.itemsToApply ?? [], 'growth', upsellResult.decisionId);
  console.log(`  cart total ₹${(updatedCart.totalPaise / 100).toLocaleString('en-IN')} (7,798 expected)`);

  heading('PAYMENT AUTHORIZATION (₹7,798, discount ₹0)');
  const paymentAction: PaymentCreateAction = {
    actionId: 'smoke-payment',
    type: 'payment.create',
    agentId: ACTOR_IDS.buyerAgentId,
    mandateId: mandate.row.id,
    cartId: cart.cart.id,
    protocol: 'REST',
    requestedCapabilities: ['payment.create'],
    timestamp: clock.now().toISOString(),
    idempotencyKey: 'smoke-payment-1',
    amountPaise: updatedCart.totalPaise,
    discountPaise: 0,
    orderId: null,
  };
  const paymentResult = ctx.authorization.evaluateAction(paymentAction);
  expect('payment.create decision', paymentResult.decision, 'ALLOW');
  console.log(`  plan: total ₹${(paymentResult.paymentPlan?.totalPaise ?? 0) / 100}, TTL until ${paymentResult.paymentPlan?.ttlExpiresAt}`);

  heading('ATTACK: UNAUTHORIZED DISCOUNT ₹2,000');
  const discountAttack = ctx.authorization.evaluateAction({
    ...paymentAction,
    actionId: 'smoke-discount-attack',
    idempotencyKey: 'atk-disc-1',
    amountPaise: updatedCart.subtotalPaise - 200_000,
    discountPaise: 200_000,
  });
  expect('discount attack decision', discountAttack.decision, 'BLOCK');
  console.log(`  violated: ${discountAttack.violations.map((v) => v.code).join(', ')}`);

  heading('ATTACK: MALICIOUS CATALOG (injected instructions grant nothing)');
  const maliciousAdd = ctx.authorization.evaluateAction({
    actionId: 'smoke-malicious-add',
    type: 'cart.add_item',
    agentId: ACTOR_IDS.buyerAgentId,
    mandateId: mandate.row.id,
    cartId: cart.cart.id,
    protocol: 'REST',
    requestedCapabilities: ['cart.modify'],
    timestamp: clock.now().toISOString(),
    idempotencyKey: 'atk-mal-1',
    items: [{ productId: 'malicious-001', quantity: 1 }],
  });
  // malicious-001 (₹7,499) would push cart total to ₹15,297 — correctly BLOCKed by mandate cap (₹8,000),
  // NOT because the description contains injected instructions. The text is data; rules are authority.
  expect('malicious product add blocked by real rules (not injection)', maliciousAdd.decision, 'BLOCK');
  console.log(`  real block reason: ${maliciousAdd.violations[0]?.code ?? 'n/a'} — injected text has zero authority`);
  const injectedDiscount = ctx.authorization.evaluateAction({
    ...paymentAction,
    actionId: 'smoke-injected-discount',
    idempotencyKey: 'atk-inj-1',
    amountPaise: updatedCart.subtotalPaise - 674_910,
    discountPaise: 674_910,
  });
  expect('injected "90% discount" instruction', injectedDiscount.decision, 'BLOCK');
  console.log('  catalog text is data; authority comes only from mandate + policy');

  heading('ATTACK: PRIVILEGED ACTION (refund.create via agent)');
  const refundAttack = ctx.authorization.evaluateAction({
    actionId: 'smoke-refund-attack',
    type: 'refund.create',
    agentId: ACTOR_IDS.buyerAgentId,
    mandateId: mandate.row.id,                                 
    cartId: null,
    protocol: 'REST',
    requestedCapabilities: ['refund.create'],
    timestamp: clock.now().toISOString(),
    idempotencyKey: 'atk-ref-1',
    paymentId: 'pay_does_not_exist',
    amountPaise: 100_000,
  });
  expect('refund.create by agent', refundAttack.decision, 'BLOCK');
  console.log(`  violated: ${refundAttack.violations.map((v) => v.code).join(', ')}`);

  heading('ATTACK: REPLAY (duplicate idempotency key)');
  const replay = ctx.authorization.evaluateAction(createAction);
  expect('replayed cart.create', replay.decision, 'BLOCK');
  console.log(`  violated: ${replay.violations.map((v) => v.code).join(', ')}`);

  heading('AUDIT CHAIN');
  const chain = ctx.audit.verifyChain();
  expect('chain valid', String(chain.valid), 'true');
  console.log(`  ${chain.message}`);

  heading('SAMPLE RECEIPT (payment authorization)');
  console.log(paymentResult.receipt.integrityChecks.map((c) => `${c.status}  ${c.label}`).join('\n'));

  heading('RESULT');
  console.log(`  ${pass} passed, ${fail} failed`);
  handle.close();
  if (fail > 0) process.exit(1);
}

main();
