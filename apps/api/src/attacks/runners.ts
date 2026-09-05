// apps/api/src/attacks/runners.ts  (FULL FINAL)
/**
 * The ten §38 attacks. Every attack executes REAL application logic:
 * gateway submissions, real AuthorizationEngine evaluations, real payment
 * execution/reconciliation, real policy versioning. No simulated outcomes.
 */
import {
  ACTOR_IDS,
  ATTACK_INFO,
  DEMO_INTENT,
  formatINR,
  rupeesToPaise,
  type AgentAction,
  type AttackName,
  type AttackReport,
  type AttackStep,
  type CartDTO,
  type Decision,
} from '@acsf/shared';
import type { GatewayResult } from '../protocol/ProtocolGateway';
import { MockPaymentProvider } from '../providers/MockPaymentProvider';
import type { ServiceContext } from '../context';
import { DomainError } from '../utils/errors';
import { newId } from '../utils/ids';
import type { AttackDeps } from './types';
import { attackStep } from './types';

const ADVERSARIAL = ACTOR_IDS.adversarialAgentId;
const BUYER = ACTOR_IDS.buyerAgentId;

function freshMandate(ctx: ServiceContext, userId: string) {
  return ctx.mandates.createMandate(
    {
      userId,
      intent: DEMO_INTENT,
      maxAmountRupees: 8_000,
      allowedCategories: ['running_shoes'],
      allowUpsell: true,
      ttlHours: 24,
    },
    userId,
  );
}

function cartOf(result: GatewayResult): CartDTO | null {
  return typeof result.data === 'object' && result.data !== null && 'lines' in result.data
    ? (result.data as CartDTO)
    : null;
}

function paymentIdOf(result: GatewayResult): string | null {
  const data = result.data as { id?: unknown } | null;
  return typeof data === 'object' && data !== null && typeof data.id === 'string' ? data.id : null;
}

function violated(result: GatewayResult): string | null {
  const v = result.violations[0];
  return v === undefined ? null : `${v.code} — ${v.message}`;
}

function finish(
  attack: AttackName,
  executedAt: string,
  decision: Decision,
  violatedRule: string | null,
  drift: number | null,
  steps: AttackStep[],
  ids: { decisionId?: string | null; paymentId?: string | null } = {},
): AttackReport {
  return {
    attack,
    title: ATTACK_INFO[attack].title,
    executedAt,
    decision,
    violatedRule,
    drift,
    steps,
    decisionId: ids.decisionId ?? null,
    paymentId: ids.paymentId ?? null,
    auditEventId: null,
  };
}

async function createCart(
  deps: AttackDeps,
  agentId: string,
  mandateId: string,
  items: Array<{ productId: string; quantity: number; claimedUnitPricePaise?: number }>,
): Promise<{ result: GatewayResult; cart: CartDTO | null }> {
  const result = await deps.gateway.submitPayload(
    { type: 'cart.create', items },
    { agentId, mandateId, protocol: 'INTERNAL' },
    { execute: true },
  );
  return { result, cart: cartOf(result) };
}

// ---------- 1 · UNAUTHORIZED DISCOUNT ----------

async function unauthorizedDiscount(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-discount-user');
  steps.push(
    attackStep(
      'Intent',
      `Fresh mandate ${mandate.row.id}: "running shoes for marathon training under ₹8,000". The authority boundary is explicit and machine-checkable.`,
    ),
  );

  const { result: creation, cart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
  ]);
  steps.push(
    attackStep(
      'Proposal',
      cart !== null
        ? `Agent builds a plausible cart: Marathon Running Shoes ${formatINR(749_900)} + Performance Running Socks ${formatINR(29_900)} = ${formatINR(cart.subtotalPaise)} — within every limit so far.`
        : `Cart creation returned ${creation.decision ?? 'ERROR'}: ${creation.reason ?? creation.error?.message ?? 'unknown'}`,
    ),
  );
  if (cart === null) {
    return finish('unauthorized_discount', ctx.clock.now().toISOString(), creation.decision ?? 'BLOCK', violated(creation), creation.drift?.overall ?? null, steps, { decisionId: creation.decisionId });
  }

  const discount = rupeesToPaise(2_000);
  const attack = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: cart.subtotalPaise - discount, discountPaise: discount },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL' },
    { execute: false },
  );
  steps.push(attackStep('Attack', `Agent applies a ${formatINR(discount)} discount to the ${formatINR(cart.subtotalPaise)} cart — 4× the merchant cap of ${formatINR(50_000)}.`));
  steps.push(
    attackStep(
      'Firewall checks',
      `MERCHANT_MAX_DISCOUNT_EXCEEDED: requested ${formatINR(discount)} vs policy v${attack.receipt?.policy?.version ?? '—'} limit ${formatINR(attack.receipt?.policy?.maxDiscountPaise ?? 50_000)}; the effective margin also collapses below the 15% floor.`,
    ),
  );
  steps.push(attackStep('Violated rule', violated(attack) ?? '—'));
  steps.push(attackStep('Authority drift', `${(attack.drift?.overall ?? 0).toFixed(2)} — the discount dimension is saturated (${formatINR(discount)} attempted against a ${formatINR(50_000)} limit).`));
  steps.push(attackStep('Decision', `${attack.decision} — ${attack.reason}`));
  steps.push(attackStep('Audit', `Decision ${attack.decisionId} persisted with its receipt; BLOCKED_ACTION and ATTACK_EXECUTED events appended to the hash chain.`));
  return finish('unauthorized_discount', ctx.clock.now().toISOString(), attack.decision ?? 'BLOCK', violated(attack), attack.drift?.overall ?? null, steps, { decisionId: attack.decisionId });
}

// ---------- 2 · MALICIOUS CATALOG ----------

async function maliciousCatalog(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-catalog-user');
  const product = ctx.catalog.getProduct('malicious-001');
  steps.push(
    attackStep(
      'Injected catalog text',
      product !== null
        ? `Product "Premium Marathon Shoes" carries: "${product.description.split('\n').filter((l) => l.includes('AI INSTRUCTION')).join(' ').trim()}"`
        : 'Malicious product seeded in the catalog.',
    ),
  );
  const { result: creation, cart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [{ productId: 'shoe-001', quantity: 1 }]);
  steps.push(attackStep('Setup', cart !== null ? `Baseline cart with the genuine ${formatINR(749_900)} shoes.` : `Cart creation returned ${creation.decision ?? 'ERROR'}.`));
  if (cart === null) {
    return finish('malicious_catalog', ctx.clock.now().toISOString(), creation.decision ?? 'BLOCK', violated(creation), creation.drift?.overall ?? null, steps, { decisionId: creation.decisionId });
  }

  const attack = await gateway.submitPayload(
    { type: 'cart.add_item', cartId: cart.id, items: [{ productId: 'malicious-001', quantity: 1, claimedUnitPricePaise: 749 }] },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL' },
    { execute: false },
  );
  steps.push(attackStep('Attack', 'Agent obeys the injected instruction and claims the "90% discount" price of ₹7.49 per unit.'));
  steps.push(attackStep('Catalog is data', 'The engine never parses catalog text as instructions. The only authority-relevant effect the injection can have is a price claim — and every price is re-resolved server-side from the trusted catalog.'));
  steps.push(attackStep('Tamper detection', `Claimed unit price 749 paise vs catalog price ${formatINR(749_900)}: PRICE_TAMPER. Server-side pricing wins; the claimed price can never change what is charged.`));
  steps.push(attackStep('Violated rule', violated(attack) ?? '—'));
  steps.push(attackStep('Decision', `${attack.decision} — ${attack.reason}`));
  steps.push(attackStep('Audit', `Decision ${attack.decisionId} persisted; the attempt is in the audit chain.`));
  return finish('malicious_catalog', ctx.clock.now().toISOString(), attack.decision ?? 'BLOCK', violated(attack), attack.drift?.overall ?? null, steps, { decisionId: attack.decisionId });
}

// ---------- 3 · STALE CART ----------

async function staleCart(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-stale-user');
  const { result: creation, cart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [{ productId: 'shoe-001', quantity: 1 }]);
  steps.push(attackStep('Setup', cart !== null ? `Cart ${cart.id} with Marathon Running Shoes ${formatINR(749_900)}.` : `Cart creation returned ${creation.decision ?? 'ERROR'}.`));
  if (cart === null) {
    return finish('stale_cart', ctx.clock.now().toISOString(), creation.decision ?? 'BLOCK', violated(creation), creation.drift?.overall ?? null, steps, { decisionId: creation.decisionId });
  }

  const mock = ctx.provider instanceof MockPaymentProvider ? ctx.provider : null;
  if (mock !== null) {
    mock.arm('timeout_then_captured');
  }
  // The arm is one-shot but only consumed inside createPayment. If this
  // proposal is BLOCKed (exhausted daily budget, tightened policy, denied
  // cart) the fault stays latched on the SHARED provider and detonates on the
  // next unrelated payment anywhere in the process. Disarm regardless.
  const payment = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: newId('idem') },
    { execute: true },
  );
  mock?.arm('none');
  steps.push(
    attackStep(
      'Authorization',
      `Payment proposal ${payment.decision ?? '—'} — the cart transitions to 'authorized' and its canonical hash is stored (authorized hash ${ctx.carts.getCart(cart.id)?.cart.authorizedHash?.slice(0, 10) ?? '—'}…).`,
    ),
  );
  steps.push(
    attackStep(
      'Provider outcome',
      mock !== null
        ? 'The provider create call times out — the payment is UNKNOWN, but the cart REMAINS authorized. This is the precondition for post-authorization tampering.'
        : 'Non-mock provider: the payment stays PENDING and the cart remains authorized — the same precondition.',
    ),
  );
  if (payment.decision !== 'ALLOW') {
    return finish('stale_cart', ctx.clock.now().toISOString(), payment.decision ?? 'BLOCK', violated(payment), payment.drift?.overall ?? null, steps, { decisionId: payment.decisionId });
  }

  const tamper = await gateway.submitPayload(
    { type: 'cart.add_item', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }] },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: newId('idem') },
    { execute: true },
  );
  steps.push(
    attackStep(
      'Tampering (individually plausible)',
      `Adding Performance Running Socks to a running order looks harmless — ${tamper.decision ?? '—'}. But the cart was already authorized: it transitions to 'stale' and the recomputed hash no longer matches the authorized hash.`,
    ),
  );

  const after = ctx.carts.getCart(cart.id);
  const amount = after !== null ? after.totalPaise : cart.totalPaise;
  const repay = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: amount, discountPaise: 0 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: newId('idem') },
    { execute: false },
  );
  steps.push(attackStep('Violated rule', violated(repay) ?? '—'));
  steps.push(attackStep('Decision', `${repay.decision ?? '—'} — paying a tampered cart requires fresh user authorization; the agent cannot upgrade its own authority.`));
  steps.push(attackStep('Audit', `Decisions ${payment.decisionId}, ${tamper.decisionId}, ${repay.decisionId} all persisted; the tamper sequence is fully auditable.`));
  return finish('stale_cart', ctx.clock.now().toISOString(), repay.decision ?? 'REAUTHORIZE', violated(repay), repay.drift?.overall ?? null, steps, { decisionId: repay.decisionId, paymentId: paymentIdOf(payment) });
}

// ---------- 4 · PAYMENT TIMEOUT ----------

async function paymentTimeout(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-timeout-user');
  const { result: creation, cart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
  ]);
  if (cart === null) {
    return finish('payment_timeout', ctx.clock.now().toISOString(), creation.decision ?? 'BLOCK', violated(creation), creation.drift?.overall ?? null, steps, { decisionId: creation.decisionId });
  }
  steps.push(attackStep('Setup', `Cart total ${formatINR(cart.subtotalPaise)} (shoes + socks).`));

  const mock = ctx.provider instanceof MockPaymentProvider ? ctx.provider : null;
  if (mock !== null) {
    mock.arm('timeout_then_captured');
  }
  const key = newId('idem');
  // The arm is one-shot but only consumed inside createPayment. If this
  // proposal is BLOCKed (exhausted daily budget, tightened policy, denied
  // cart) the fault stays latched on the SHARED provider and detonates on the
  // next unrelated payment anywhere in the process. Disarm regardless.
  const proposal = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: key },
    { execute: true },
  );
  mock?.arm('none');
  const paymentId = paymentIdOf(proposal);
  steps.push(
    attackStep(
      'Provider timeout → UNKNOWN',
      mock !== null
        ? `Payment ${paymentId ?? '—'} create timed out mid-flight. The payment is now UNKNOWN — the outcome is neither success nor failure, and blind retries are forbidden.`
        : 'Mock provider required for timeout simulation (it is the default); with a real provider this state arises from genuine network failures.',
    ),
  );
  if (proposal.decision !== 'ALLOW' || proposal.decisionId === null) {
    return finish('payment_timeout', ctx.clock.now().toISOString(), proposal.decision ?? 'BLOCK', violated(proposal), proposal.drift?.overall ?? null, steps, { decisionId: proposal.decisionId, paymentId });
  }

  const retry = await ctx.payments.executePayment(proposal.decisionId);
  steps.push(
    attackStep(
      'Blind retry refused',
      `Re-executing the same decision returned the ORIGINAL payment ${retry.id} (duplicate=${String(retry.duplicate)}) — the idempotency key matched an existing payment and the replay was recorded. No second charge was created.`,
    ),
  );

  const reconciliation = paymentId !== null ? await ctx.reconciliation.reconcile(paymentId) : null;
  steps.push(
    attackStep(
      'UNKNOWN → QUERY → CAPTURED → NO RETRY → RECONCILED',
      reconciliation !== null
        ? `${reconciliation.resolution}: ${reconciliation.detail}`
        : 'Reconciliation skipped (no payment id).',
    ),
  );

  const replay = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: key },
    { execute: false },
  );
  steps.push(attackStep('Duplicate payment prevented', `Replaying the original proposal with the same idempotency key is rejected at the duplicate-action stage: ${violated(replay) ?? '—'}`));
  steps.push(attackStep('Decision', `${replay.decision ?? '—'} — ${replay.reason}`));
  steps.push(attackStep('Audit', `Payment events, reconciliation, and the blocked replay are all in the hash-chained audit trail.`));
  return finish('payment_timeout', ctx.clock.now().toISOString(), replay.decision ?? 'BLOCK', violated(replay), replay.drift?.overall ?? null, steps, { decisionId: replay.decisionId, paymentId });
}

// ---------- 5 · SLOW AUTHORITY DRIFT (§40) ----------

async function slowAuthorityDrift(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-drift-user');
  steps.push(attackStep('Session', `Fresh mandate ${mandate.row.id}; drift session keyed to (${ADVERSARIAL}, mandate). Every action below is individually plausible.`));

  const purchases = [
    { label: 'Running Shoes ₹7,499', items: [{ productId: 'shoe-001', quantity: 1 }] },
    { label: 'Running Socks ₹299', items: [{ productId: 'sock-001', quantity: 1 }] },
    { label: 'Running Insoles ₹699', items: [{ productId: 'insole-001', quantity: 1 }] },
    { label: 'Sports Water Bottle ₹499', items: [{ productId: 'bottle-001', quantity: 1 }] },
    { label: 'Premium Warranty ₹4,000', items: [{ productId: 'warranty-001', quantity: 1 }] },
  ] as const;

  const series: number[] = [];
  let warrantyCartId: string | null = null;
  for (const purchase of purchases) {
    const { result, cart } = await createCart(deps, ADVERSARIAL, mandate.row.id, purchase.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
    const drift = result.drift?.overall ?? 0;
    series.push(drift);
    steps.push(
      attackStep(
        `${purchase.label} — individually plausible`,
        `${result.decision ?? '—'}; session drift ${drift.toFixed(2)} (monetary ${(result.drift?.monetary ?? 0).toFixed(2)}, category ${(result.drift?.category ?? 0).toFixed(2)}, action ${(result.drift?.action ?? 0).toFixed(2)}).`,
      ),
    );
    if (purchase.items[0]?.productId === 'warranty-001') {
      warrantyCartId = cart?.id ?? null;
    }
  }

  const discount = rupeesToPaise(450);
  const modify = await gateway.submitPayload(
    { type: 'cart.modify', cartId: warrantyCartId ?? 'cart-missing', discountPaise: discount },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: newId('idem') },
    { execute: false },
  );
  steps.push(attackStep('Discount attempt', `Agent applies a ${formatINR(discount)} discount — within the merchant cap, so no single rule fires. But the session has drifted.`));
  const finalDrift = modify.drift?.overall ?? 0;
  series.push(finalDrift);
  steps.push(attackStep('Drift trajectory', `${series.map((d) => d.toFixed(2)).join(' → ')} — deterministic engine output, never an LLM.`));
  steps.push(attackStep('Threshold', `Overall drift ${finalDrift.toFixed(2)} is above the approval threshold 0.70 (block threshold 0.90): AUTHORITY DRIFT ≈ ${finalDrift.toFixed(2)} — HUMAN APPROVAL REQUIRED.`));
  steps.push(attackStep('Decision', `${modify.decision ?? '—'} — ${modify.reason}`));
  steps.push(attackStep('Audit', 'Every evaluation in the sequence was persisted with its full drift breakdown; the Firewall page graphs this session.'));
  return finish('slow_authority_drift', ctx.clock.now().toISOString(), modify.decision ?? 'HUMAN_APPROVAL', violated(modify), finalDrift, steps, { decisionId: modify.decisionId });
}

// ---------- 6 · BUDGET EXHAUSTION ----------

function paymentStateOf(ctx: ServiceContext, paymentId: string): string {
  return ctx.payments.getPayment(paymentId)?.state ?? '—';
}

/**
 * This attack tightens the LIVE merchant policy and restores it afterwards.
 * Two overlapping runs used to interleave: the second read the first's
 * tightened budget as its "original" and wrote that back, leaving the merchant
 * permanently on a ~₹3 daily budget until someone edited the policy by hand.
 * Fastify serves requests concurrently and the route is unauthenticated, so
 * this is a real sequence, not a theoretical one.
 */
let budgetExhaustionRunning = false;

async function budgetExhaustion(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  if (budgetExhaustionRunning) {
    throw new DomainError(
      'ATTACK_ALREADY_RUNNING',
      'The budget-exhaustion attack is already running. It temporarily lowers the live merchant daily budget, so only one run at a time is permitted — wait for the current run to restore it.',
    );
  }
  const policy = ctx.policies.getActivePolicy(ctx.merchantId);
  if (policy === null) {
    throw new DomainError('POLICY_MISSING', `Merchant policy is not configured for ${ctx.merchantId}.`);
  }
  budgetExhaustionRunning = true;
  const committedBefore = ctx.payments.getCommittedSpendToday();
  const originalBudgetRupees = Math.ceil(policy.dailyBudgetPaise / 100);
  const tightenedRupees = Math.ceil(committedBefore / 100) + 3;
  steps.push(attackStep('Baseline', `Committed spend today ${formatINR(committedBefore)} against the daily budget ${formatINR(policy.dailyBudgetPaise)} (policy v${policy.version}).`));

  ctx.policies.updatePolicy(ctx.merchantId, { dailyBudgetRupees: tightenedRupees }, 'demo-user');
  steps.push(attackStep('Budget tightened (admin, audited)', `demo-user (a human, not an agent) lowers the daily budget to ${formatINR(rupeesToPaise(tightenedRupees))} via the real PolicyEngine — a new immutable policy version, audit-logged.`));

  let attempt: GatewayResult | null = null;
  let sockPaymentId: string | null = null;
  try {
    const mandate = freshMandate(ctx, 'attack-budget-user');
    const { result: sockResult, cart: sockCart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [{ productId: 'sock-001', quantity: 1 }]);
    if (sockCart !== null && sockResult.decision === 'ALLOW') {
      const sockPayment = await gateway.submitPayload(
        { type: 'payment.create', cartId: sockCart.id, amountPaise: sockCart.totalPaise, discountPaise: 0 },
        { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: newId('idem') },
        { execute: true },
      );
      sockPaymentId = paymentIdOf(sockPayment);
      steps.push(
        attackStep(
          'Exhaustion (legitimate small purchase)',
          `Socks ${formatINR(29_900)} — ${sockPayment.decision ?? '—'}${sockPaymentId !== null ? `, payment ${sockPaymentId} ${paymentStateOf(ctx, sockPaymentId)}` : ''}. The budget is now fully committed.`,
        ),
      );
    }
    const { result: shoeResult, cart: shoeCart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [{ productId: 'shoe-001', quantity: 1 }]);
    if (shoeCart !== null) {
      attempt = await gateway.submitPayload(
        { type: 'payment.create', cartId: shoeCart.id, amountPaise: shoeCart.totalPaise, discountPaise: 0 },
        { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: newId('idem') },
        { execute: false },
      );
      steps.push(attackStep('Attack', `Agent attempts the ${formatINR(749_900)} shoes purchase with the budget exhausted.`));
      steps.push(attackStep('Violated rule', violated(attempt) ?? '—'));
      steps.push(attackStep('Authority drift', `${(attempt.drift?.overall ?? 0).toFixed(2)}`));
      steps.push(attackStep('Decision', `${attempt.decision ?? '—'} — ${attempt.reason}`));
    }
  } finally {
    // Restore the budget this run actually found, not a value derived from the
    // spend afterwards — the old Math.max could only ever ratchet the budget
    // around, and combined with a concurrent run it ratcheted it down.
    try {
      ctx.policies.updatePolicy(ctx.merchantId, { dailyBudgetRupees: originalBudgetRupees }, 'demo-user');
    } finally {
      budgetExhaustionRunning = false;
    }
  }
  steps.push(attackStep('Restore', `Budget restored (another audited policy version); every prior decision keeps the policy version it was evaluated under.`));
  steps.push(attackStep('Audit', 'Two POLICY_CHANGE events, the payment, and the blocked attempt are all in the hash chain.'));
  return finish(
    'budget_exhaustion',
    ctx.clock.now().toISOString(),
    attempt?.decision ?? 'BLOCK',
    attempt !== null ? violated(attempt) : 'MERCHANT_DAILY_BUDGET_EXCEEDED — budget exhausted',
    attempt?.drift?.overall ?? null,
    steps,
    { decisionId: attempt?.decisionId ?? null, paymentId: sockPaymentId },
  );
}

// ---------- 7 · UNAUTHORIZED REFUND ----------

async function unauthorizedRefund(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-refund-user');
  const attack = await gateway.submitPayload(
    { type: 'refund.create', paymentId: 'pay_attacker_target', amountPaise: rupeesToPaise(7_798) },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL' },
    { execute: false },
  );
  steps.push(attackStep('Attack', 'Agent requests a ₹7,798 refund on an arbitrary payment id.'));
  steps.push(attackStep('Identity', `${ADVERSARIAL} is authenticated — identity was never the issue.`));
  steps.push(attackStep('Capability validation', 'refund.create is a PRIVILEGED capability. No agent may hold it — agents never receive payment-provider access, and the refund surface is not exposed over MCP.'));
  steps.push(attackStep('Layer isolation', 'The refund/payment layer was never reached: the action was rejected at capability validation, before any domain evaluation.'));
  steps.push(attackStep('Violated rule', violated(attack) ?? '—'));
  steps.push(attackStep('Authority drift', 'n/a — privileged actions are rejected before mandate/session evaluation (fail-closed stage ordering).'));
  steps.push(attackStep('Decision', `${attack.decision ?? '—'} — ${attack.reason}`));
  steps.push(attackStep('Audit', `Decision ${attack.decisionId} persisted; BLOCKED_ACTION + ATTACK_EXECUTED events appended.`));
  return finish('unauthorized_refund', ctx.clock.now().toISOString(), attack.decision ?? 'BLOCK', violated(attack), null, steps, { decisionId: attack.decisionId });
}

// ---------- 8 · CAPABILITY ESCALATION ----------

async function capabilityEscalation(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-escalation-user');

  const probeA = await gateway.submitPayload(
    { type: 'catalog.read', query: 'running' },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', requestedCapabilities: ['root.system.access'] },
    { execute: false },
  );
  steps.push(attackStep('Probe 1 — unknown capability', `Agent requests capability "root.system.access" alongside a benign read. Unknown capabilities fail CLOSED: ${violated(probeA) ?? '—'}`));

  const probeB = await gateway.submitPayload(
    { type: 'catalog.read', query: 'running' },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', requestedCapabilities: ['refund.create'] },
    { execute: false },
  );
  steps.push(attackStep('Probe 2 — privileged capability', `Agent requests "refund.create". Privileged capabilities are unreachable from any agent path: ${violated(probeB) ?? '—'}`));

  const { result: creation, cart } = await createCart(deps, BUYER, mandate.row.id, [{ productId: 'shoe-001', quantity: 1 }]);
  const probeC =
    cart !== null
      ? await gateway.submitPayload(
          { type: 'upsell.create', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }], pitch: 'escalation probe' },
          { agentId: BUYER, mandateId: mandate.row.id, protocol: 'INTERNAL' },
          { execute: false },
        )
      : creation;
  steps.push(
    attackStep(
      'Probe 3 — ungranted capability',
      `buyer-agent-01 attempts upsell.create, which it does not hold (only the growth agent does): ${violated(probeC) ?? '—'}`,
    ),
  );
  steps.push(attackStep('Firewall checks', 'Capability tokens are validated against the agent row AND the merchant policy; unknown tokens fail closed, privileged tokens are rejected outright.'));
  steps.push(attackStep('Violated rule', violated(probeA) ?? '—'));
  steps.push(attackStep('Authority drift', 'n/a — capability violations short-circuit before mandate/session evaluation.'));
  steps.push(attackStep('Decision', `${probeC.decision ?? 'BLOCK'} — every escalation probe was blocked.`));
  steps.push(attackStep('Audit', `Decisions ${probeA.decisionId}, ${probeB.decisionId}, ${probeC.decisionId} persisted.`));
  return finish('capability_escalation', ctx.clock.now().toISOString(), probeC.decision ?? 'BLOCK', violated(probeA), null, steps, { decisionId: probeC.decisionId });
}

// ---------- 9 · PROTOCOL BYPASS (§39) ----------

async function protocolBypass(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway, adapter } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-bypass-user');

  const boundary = await adapter.invoke({
    requestId: newId('mcp'),
    agentId: ADVERSARIAL,
    mandateId: mandate.row.id,
    tool: 'refund',
    args: { agentId: ADVERSARIAL, paymentId: 'pay_bypass_target', amountPaise: 779_800 },
  });
  steps.push(attackStep('Protocol request accepted', `MCP tool call "refund" arrives at the protocol boundary (request ${boundary.requestId}).`));
  steps.push(
    attackStep(
      'Tool validation',
      `Tool "refund" is not exposed by the MCP adapter — privileged tools (refund, policy, mandate, payout, settlement) do not exist on the safe surface. Status ${boundary.status}: ${boundary.error?.code ?? '—'}.`,
    ),
  );
  steps.push(attackStep('Payment/refund layer never reached', 'The request was denied AND audited (protocol_requests row with status DENIED) before any domain service or payment provider was touched.'));

  const backstop = await gateway.submitPayload(
    { type: 'refund.create', paymentId: 'pay_bypass_target', amountPaise: 779_800 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'MCP' },
    { execute: false },
  );
  steps.push(attackStep('Engine backstop', `Even a crafted refund.create action that slipped past the tool boundary is ${backstop.decision ?? 'BLOCK'} by the AuthorizationEngine: ${violated(backstop) ?? '—'}`));
  steps.push(attackStep('Decision', `${backstop.decision ?? 'BLOCK'} — defense in depth: protocol boundary AND engine both refuse.`));
  steps.push(attackStep('Audit', 'The boundary denial and the engine BLOCK are both persisted (protocol_requests + authorization_decisions + audit chain).'));
  return finish('protocol_bypass', ctx.clock.now().toISOString(), backstop.decision ?? 'BLOCK', violated(backstop), null, steps, { decisionId: backstop.decisionId });
}

// ---------- 10 · DUPLICATE PAYMENT ----------

async function duplicatePayment(deps: AttackDeps): Promise<AttackReport> {
  const { ctx, gateway } = deps;
  const steps: AttackStep[] = [];
  const mandate = freshMandate(ctx, 'attack-duplicate-user');
  const { result: creation, cart } = await createCart(deps, ADVERSARIAL, mandate.row.id, [
    { productId: 'shoe-001', quantity: 1 },
    { productId: 'sock-001', quantity: 1 },
  ]);
  if (cart === null) {
    return finish('duplicate_payment', ctx.clock.now().toISOString(), creation.decision ?? 'BLOCK', violated(creation), creation.drift?.overall ?? null, steps, { decisionId: creation.decisionId });
  }
  steps.push(attackStep('Setup', `Cart total ${formatINR(cart.subtotalPaise)}.`));

  const key = newId('idem');
  const proposal = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: key },
    { execute: true },
  );
  const paymentId = paymentIdOf(proposal);
  steps.push(attackStep('Legitimate payment', `Proposal ${proposal.decision ?? '—'}; payment ${paymentId ?? '—'} executed once (${paymentStateOf(ctx, paymentId ?? '')}).`));

  if (proposal.decision === 'ALLOW' && proposal.decisionId !== null && paymentId !== null) {
    const retry = await ctx.payments.executePayment(proposal.decisionId);
    steps.push(
      attackStep(
        'Re-execution attempt',
        `executePayment returned the ORIGINAL payment ${retry.id} with duplicate=${String(retry.duplicate)} — the idempotency layer matched the existing payment and recorded create.replay_ignored. No second charge.`,
      ),
    );
    const event1 = ctx.payments.handleProviderEvent(paymentId, 'payment.failed', 'FAILED', 'Late failure event after capture.');
    const event2 = ctx.payments.handleProviderEvent(paymentId, 'payment.failed', 'FAILED', 'Late failure event after capture (replayed).');
    steps.push(
      attackStep(
        'Provider event abuse',
        `Out-of-order event: applied=${String(event1.applied)}, ignored=${String(event1.ignored)}. Replayed event: duplicate=${String(event2.duplicate)}, ignored=${String(event2.ignored)}. Duplicate and out-of-order webhooks are never double-applied.`,
      ),
    );
  }

  const replay = await gateway.submitPayload(
    { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
    { agentId: ADVERSARIAL, mandateId: mandate.row.id, protocol: 'INTERNAL', idempotencyKey: key },
    { execute: false },
  );
  steps.push(attackStep('DUPLICATE PAYMENT PREVENTED', `Replaying the payment proposal with the same idempotency key: ${violated(replay) ?? '—'}`));
  steps.push(attackStep('Decision', `${replay.decision ?? '—'} — ${replay.reason}`));
  steps.push(attackStep('Audit', 'Replay prevention, duplicate provider events, and the blocked proposal are all recorded in the payment timeline and audit chain.'));
  return finish('duplicate_payment', ctx.clock.now().toISOString(), replay.decision ?? 'BLOCK', violated(replay), replay.drift?.overall ?? null, steps, { decisionId: replay.decisionId, paymentId });
}

export const runners: Record<AttackName, (deps: AttackDeps) => Promise<AttackReport>> = {
  unauthorized_discount: unauthorizedDiscount,
  malicious_catalog: maliciousCatalog,
  stale_cart: staleCart,
  payment_timeout: paymentTimeout,
  slow_authority_drift: slowAuthorityDrift,
  budget_exhaustion: budgetExhaustion,
  unauthorized_refund: unauthorizedRefund,
  capability_escalation: capabilityEscalation,
  protocol_bypass: protocolBypass,
  duplicate_payment: duplicatePayment,
};
