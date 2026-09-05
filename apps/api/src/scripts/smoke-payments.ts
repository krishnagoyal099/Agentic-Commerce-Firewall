// apps/api/src/scripts/smoke-payments.ts
/**
 * End-to-end payment safety smoke test on an in-memory database:
 *   1. ALLOW → execute → CAPTURED (order completed, cart paid)
 *   2. duplicate execution → PREVENTED
 *   3. timeout → UNKNOWN → blind retry prevented → reconcile → ALREADY CAPTURED → NO RETRY
 *   4. timeout → UNKNOWN → reconcile → NOT_FOUND → SAFE RETRY → re-propose → CAPTURED
 *   5. out-of-order provider event ignored; duplicate provider event detected
 *   6. audit chain intact
 * Run: npm run smoke:payments
 */
import { ACTOR_IDS, DEMO_INTENT, type CartCreateAction, type PaymentCreateAction } from '@acsf/shared';
import { buildServiceContext } from '../context';
import { createDatabase } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedDatabase } from '../db/seed';
import { MockPaymentProvider } from '../providers/MockPaymentProvider';
import { SystemClock } from '../utils/clock';

function heading(label: string): void {
  console.log(`\n━━━ ${label} ${'━'.repeat(Math.max(0, 58 - label.length))}`);
}

async function main(): Promise<void> {
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
    const ok = actual === expected;
    if (ok) pass += 1;
    else fail += 1;
    console.log(`${ok ? '  ✔' : '  ✘'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  }

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

  let counter = 0;
  const buyer = ACTOR_IDS.buyerAgentId;
  const mockProvider = ctx.provider instanceof MockPaymentProvider ? ctx.provider : null;
  if (!mockProvider) throw new Error('This demo requires the mock payment provider.');

  const createCart = (): { cartId: string; totalPaise: number } => {
    counter += 1;
    const action: CartCreateAction = {
      actionId: `sp-cart-${counter}`,
      type: 'cart.create',
      agentId: buyer,
      mandateId: mandate.row.id,
      cartId: null,
      protocol: 'REST',
      requestedCapabilities: ['cart.create'],
      timestamp: clock.now().toISOString(),
      idempotencyKey: `sp-cart-${counter}`,
      items: [{ productId: 'shoe-001', quantity: 1 }],
    };
    const evaluation = ctx.authorization.evaluateAction(action);
    if (evaluation.decision !== 'ALLOW' || evaluation.itemsToApply === null) {
      throw new Error(`cart.create unexpectedly ${evaluation.decision}: ${evaluation.reason}`);
    }
    const view = ctx.carts.createCart({
      mandateId: mandate.row.id,
      agentId: buyer,
      protocol: 'REST',
      items: evaluation.itemsToApply,
      source: 'buyer',
      decisionId: evaluation.decisionId,
    });
    return { cartId: view.cart.id, totalPaise: view.subtotalPaise };
  };

  const proposePayment = (cartId: string, totalPaise: number): Promise<string> => {
    counter += 1;
    const action: PaymentCreateAction = {
      actionId: `sp-pay-${counter}`,
      type: 'payment.create',
      agentId: buyer,
      mandateId: mandate.row.id,
      cartId,
      protocol: 'REST',
      requestedCapabilities: ['payment.create'],
      timestamp: clock.now().toISOString(),
      idempotencyKey: `sp-pay-${counter}`,
      amountPaise: totalPaise,
      discountPaise: 0,
      orderId: null,
    };
    const evaluation = ctx.authorization.evaluateAction(action);
    if (evaluation.decision !== 'ALLOW') {
      throw new Error(`payment.create unexpectedly ${evaluation.decision}: ${evaluation.reason}`);
    }
    return Promise.resolve(evaluation.decisionId);
  };

  heading('1 · HAPPY PATH — ALLOW → EXECUTE → CAPTURED');
  const first = createCart();
  const decision1 = await proposePayment(first.cartId, first.totalPaise);
  const payment1 = await ctx.payments.executePayment(decision1);
  expect('state', payment1.state, 'CAPTURED');
  expect('order completed', String(payment1.orderId !== null), 'true');
  expect('cart paid', String(ctx.carts.getCart(first.cartId)?.cart.state), 'paid');
  expect('revenue (paise)', String(ctx.payments.getRevenueCapturedPaise()), String(7499 * 100));

  heading('2 · DUPLICATE PAYMENT PREVENTED');
  const replay = await ctx.payments.executePayment(decision1);
  expect('duplicate flag', String(replay.duplicate), 'true');
  expect('same payment id', String(replay.id === payment1.id), 'true');
  expect('single row for key', String(ctx.payments.findByIdempotencyKey(payment1.idempotencyKey)?.id === payment1.id), 'true');
  expect('prevention counted', String(ctx.payments.countDuplicatePreventions() >= 1), 'true');

  heading('3 · TIMEOUT → UNKNOWN → RECONCILE → CAPTURED, NO RETRY');
  const second = createCart();
  mockProvider.arm('timeout_then_captured');
  const decision2 = await proposePayment(second.cartId, second.totalPaise);
  const unknown = await ctx.payments.executePayment(decision2);
  expect('state after timeout', unknown.state, 'UNKNOWN');
  const blindRetry = await ctx.payments.executePayment(decision2);
  expect('blind retry prevented', String(blindRetry.duplicate), 'true');
  const report = await ctx.reconciliation.reconcile(unknown.id);
  expect('resolution', report.resolution, 'ALREADY_CAPTURED_NO_RETRY');
  const resolved = ctx.payments.getPayment(unknown.id);
  expect('state', String(resolved?.state), 'CAPTURED');
  expect('reconciled', String(resolved?.reconciled), 'true');
  expect('cart paid', String(ctx.carts.getCart(second.cartId)?.cart.state), 'paid');
  expect('no retry performed', String(report.retried), 'false');

  heading('4 · TIMEOUT → NOT FOUND → SAFE RETRY → CAPTURED');
  const third = createCart();
  mockProvider.arm('timeout_then_not_found');
  const decision3 = await proposePayment(third.cartId, third.totalPaise);
  const unknown3 = await ctx.payments.executePayment(decision3);
  expect('state after timeout', unknown3.state, 'UNKNOWN');
  const report3 = await ctx.reconciliation.reconcile(unknown3.id);
  expect('resolution', report3.resolution, 'SAFE_RETRY');
  expect('payment failed', String(ctx.payments.getPayment(unknown3.id)?.state), 'FAILED');
  expect('cart released', String(ctx.carts.getCart(third.cartId)?.cart.state), 'open');
  const decision3b = await proposePayment(third.cartId, third.totalPaise);
  const retried = await ctx.payments.executePayment(decision3b);
  expect('retry captured', retried.state, 'CAPTURED');
  expect('cart paid', String(ctx.carts.getCart(third.cartId)?.cart.state), 'paid');

  heading('5 · OUT-OF-ORDER + DUPLICATE PROVIDER EVENTS');
  const ev1 = ctx.payments.handleProviderEvent(payment1.id, 'payment.failed', 'FAILED', 'Late failure event after capture.');
  expect('out-of-order ignored', String(ev1.ignored && !ev1.applied), 'true');
  const ev2 = ctx.payments.handleProviderEvent(payment1.id, 'payment.failed', 'FAILED', 'Late failure event after capture.');
  expect('duplicate detected', String(ev2.duplicate), 'true');
  expect('state unchanged', String(ctx.payments.getPayment(payment1.id)?.state), 'CAPTURED');

  heading('6 · AUDIT CHAIN');
  expect('chain valid', String(ctx.audit.verifyChain().valid), 'true');

  heading('RESULT');
  console.log(`  ${pass} passed, ${fail} failed`);
  handle.close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
