// apps/api/src/services/FuzzerService.ts
import { eq } from 'drizzle-orm';
import type {
  AgentAction,
  CartDTO,
  Decision,
  FuzzBypassRecord,
  FuzzRunDTO,
  FuzzRunStats,
} from '@acsf/shared';
import type { ActionPayload } from '../schemas';
import { buildServiceContext } from '../context';
import type { ServiceContext } from '../context';
import { createDatabase } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedDatabase } from '../db/seed';
import { ProtocolGateway } from '../protocol/ProtocolGateway';
import type { GatewayResult } from '../protocol/ProtocolGateway';
import { MockPaymentProvider } from '../providers/MockPaymentProvider';
import { FixedClock } from '../utils/clock';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import { mulberry32, pickOf, randInt } from '../utils/prng';
import type { MandateCreateInput } from './MandateService';
import * as schema from '../db/schema';

export interface FuzzerRunInput {
  cases: number;
  seed: number;
  maxSequenceLength: number;
}

export interface FuzzerRunOutput {
  run: FuzzRunDTO;
  bypasses: FuzzBypassRecord[];
  note: string;
}

// ---------- deterministic sandbox fixtures ----------
const SANDBOX_EPOCH = Date.parse('2025-06-01T10:00:00.000Z');
const MANDATE_CAP_Paise = 800_000; // every sandbox mandate uses ₹8,000
const MERCHANT_DISCOUNT_CAP_Paise = 50_000;
const SANDBOX_BUDGET_RUPEES = 100_000_000; // sandbox fixture; budget-exhaustion cases manage it via the real PolicyEngine

const BUYER = 'buyer-agent-01';
const GROWTH = 'growth-agent-01';
const ADVERSARIAL = 'adversarial-agent-01';

const AGENT_POOL: ReadonlyArray<{ id: string; weight: number }> = [
  { id: BUYER, weight: 0.5 },
  { id: GROWTH, weight: 0.25 },
  { id: ADVERSARIAL, weight: 0.25 },
];

const NEAR_PRODUCTS = ['sock-001', 'insole-001', 'bottle-001'] as const;
const FAR_PRODUCTS = ['watch-001', 'laptop-001', 'warranty-001'] as const;
const ALL_PRODUCTS: readonly string[] = [
  'shoe-001',
  ...NEAR_PRODUCTS,
  ...FAR_PRODUCTS,
  'malicious-001',
];

const SANDBOX_MANDATE_INPUT: MandateCreateInput = {
  userId: 'fuzz-user',
  intent: 'I need running shoes for marathon training under ₹8,000',
  maxAmountRupees: 8_000,
  allowedCategories: ['running_shoes'],
  allowUpsell: true,
  ttlHours: 24,
};

// ---------- env + recorder ----------

interface FuzzEnv {
  ctx: ServiceContext;
  gateway: ProtocolGateway;
  clock: FixedClock;
  rng: () => number;
  mandates: { standard: string[]; strict: string[]; broad: string[]; expired: string[] };
  keySeq: number;
}

interface StepRecord {
  description: string;
  forbidden: boolean;
  decision: Decision | 'ERROR';
  reason: string;
  violationCount: number;
}

interface CaseResult {
  category: string;
  description: string;
  outcome: Decision | 'ERROR';
  reason: string;
  violated: boolean;
  bypasses: FuzzBypassRecord[];
}

type Generator = (env: FuzzEnv, caseIndex: number, maxSequenceLength: number) => Promise<CaseResult>;

class Recorder {
  readonly steps: StepRecord[] = [];

  record(description: string, forbidden: boolean, result: GatewayResult): void {
    this.steps.push({
      description,
      forbidden,
      decision: result.decision ?? 'ERROR',
      reason: result.reason ?? result.error?.message ?? '',
      violationCount: result.violations.length,
    });
  }

  finish(caseIndex: number, category: string, description: string): CaseResult {
    const last = this.steps.at(-1);
    const bypasses: FuzzBypassRecord[] = this.steps
      .filter((s) => s.forbidden && s.decision === 'ALLOW')
      .map((s) => ({
        caseIndex,
        description: `${description} — ${s.description}`,
        outcome: s.decision,
        reason: s.reason,
      }));
    return {
      category,
      description,
      outcome: last?.decision ?? 'ERROR',
      reason: last?.reason ?? 'no steps executed',
      violated: this.steps.some((s) => s.violationCount > 0),
      bypasses,
    };
  }
}

// ---------- helpers ----------

function priceOf(env: FuzzEnv, productId: string): number {
  return env.ctx.catalog.getProduct(productId)?.pricePaise ?? 0;
}

function pickAgent(env: FuzzEnv): string {
  const r = env.rng();
  let acc = 0;
  for (const agent of AGENT_POOL) {
    acc += agent.weight;
    if (r < acc) return agent.id;
  }
  return ADVERSARIAL;
}

type MandateKind = 'standard' | 'strict' | 'broad' | 'expired';

function pickMandate(env: FuzzEnv): { id: string; kind: MandateKind } {
  const r = env.rng();
  if (r < 0.1) return { id: pickOf(env.rng, env.mandates.strict), kind: 'strict' };
  if (r < 0.3) return { id: pickOf(env.rng, env.mandates.broad), kind: 'broad' };
  return { id: pickOf(env.rng, env.mandates.standard), kind: 'standard' };
}

function allowedCategoriesFor(kind: MandateKind): string[] {
  return kind === 'broad' ? ['running_shoes', 'running_accessories'] : ['running_shoes'];
}

function offIntent(env: FuzzEnv, productId: string, kind: MandateKind): boolean {
  const product = env.ctx.catalog.getProduct(productId);
  if (product === null) return false;
  return !allowedCategoriesFor(kind).includes(product.category);
}

/** Strict mandates (allowUpsell=false) make off-intent items REAUTHORIZE — never ALLOW. */
function categoryForbidden(env: FuzzEnv, kind: MandateKind, productIds: readonly string[]): boolean {
  return kind === 'strict' && productIds.some((pid) => offIntent(env, pid, kind));
}

function subtotalOf(env: FuzzEnv, items: readonly { productId: string; quantity: number }[]): number {
  return items.reduce((sum, item) => sum + priceOf(env, item.productId) * item.quantity, 0);
}

async function submit(
  env: FuzzEnv,
  payload: ActionPayload,
  opts: {
    agentId: string;
    mandateId: string | null;
    idempotencyKey?: string;
    execute?: boolean;
    requestedCapabilities?: string[];
  },
): Promise<GatewayResult> {
  return env.gateway.submitPayload(
    payload,
    {
      agentId: opts.agentId,
      mandateId: opts.mandateId,
      protocol: 'INTERNAL',
      idempotencyKey: opts.idempotencyKey,
      requestedCapabilities: opts.requestedCapabilities,
    },
    { execute: opts.execute ?? false },
  );
}

async function makeCart(
  env: FuzzEnv,
  agentId: string,
  mandateId: string,
  items: Array<{ productId: string; quantity: number; claimedUnitPricePaise?: number }>,
): Promise<{ result: GatewayResult; cart: CartDTO | null }> {
  const result = await submit(env, { type: 'cart.create', items }, { agentId, mandateId, execute: true });
  const cart =
    typeof result.data === 'object' && result.data !== null && 'lines' in result.data
      ? (result.data as CartDTO)
      : null;
  return { result, cart };
}

/**
 * Submits a raw, structurally INVALID AgentAction. This deliberately bypasses
 * the payload (zod) layer to exercise the AuthorizationEngine's own
 * validateStructure — defense in depth is the layer under test here.
 */
async function submitRaw(env: FuzzEnv, action: AgentAction): Promise<GatewayResult> {
  return env.gateway.submit(action, { execute: false });
}

function nextKey(env: FuzzEnv): string {
  env.keySeq += 1;
  return `fzk${env.keySeq}`;
}

// ---------- case generators (§41 families) ----------

const genBenign: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const withSocks = env.rng() < 0.6;
  const items = withSocks
    ? [
        { productId: 'shoe-001', quantity: 1 },
        { productId: 'sock-001', quantity: randInt(env.rng, 1, 2) },
      ]
    : [{ productId: 'shoe-001', quantity: 1 }];
  const { result, cart } = await makeCart(env, agent, mandate.id, items);
  rec.record(`cart.create (${items.map((i) => i.productId).join('+')})`, false, result);
  if (cart !== null && result.decision === 'ALLOW') {
    const pay = await submit(
      env,
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
      { agentId: agent, mandateId: mandate.id },
    );
    rec.record('payment.create proposal', false, pay);
  }
  return rec.finish(caseIndex, 'benign', `benign ${withSocks ? 'shoes+socks' : 'shoes'} flow`);
};

const genAmount: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const big = env.rng() < 0.35;
  const items = big
    ? [
        { productId: 'shoe-001', quantity: randInt(env.rng, 1, 2) },
        { productId: pickOf(env.rng, FAR_PRODUCTS), quantity: 1 },
      ]
    : [
        { productId: 'shoe-001', quantity: randInt(env.rng, 1, 3) },
        { productId: pickOf(env.rng, NEAR_PRODUCTS), quantity: randInt(env.rng, 1, 3) },
      ];
  const subtotal = subtotalOf(env, items);
  const forbidden = subtotal > MANDATE_CAP_Paise || categoryForbidden(env, mandate.kind, items.map((i) => i.productId));
  const { result, cart } = await makeCart(env, agent, mandate.id, items);
  rec.record(`cart.create amount variation (subtotal ${subtotal} paise)`, forbidden, result);
  if (cart !== null && result.decision === 'ALLOW') {
    const pay = await submit(
      env,
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
      { agentId: agent, mandateId: mandate.id },
    );
    rec.record('payment.create proposal', false, pay);
  }
  return rec.finish(caseIndex, 'amount_variation', `amount variation subtotal ${subtotal} paise`);
};

const genDiscount: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const tier = env.rng();
  const discount =
    tier < 0.4 ? randInt(env.rng, 0, MERCHANT_DISCOUNT_CAP_Paise) : tier < 0.8 ? randInt(env.rng, 0, 200_000) : randInt(env.rng, 0, 2_000_000);
  const forbidden = discount > MERCHANT_DISCOUNT_CAP_Paise;
  const { result, cart } = await makeCart(env, agent, mandate.id, [{ productId: 'shoe-001', quantity: 1 }]);
  rec.record('cart.create baseline', false, result);
  if (cart !== null) {
    if (env.rng() < 0.5) {
      const pay = await submit(
        env,
        { type: 'payment.create', cartId: cart.id, amountPaise: Math.max(0, cart.subtotalPaise - discount), discountPaise: discount },
        { agentId: agent, mandateId: mandate.id },
      );
      rec.record(`payment.create with discount ${discount} paise`, forbidden, pay);
    } else {
      const mod = await submit(
        env,
        { type: 'cart.modify', cartId: cart.id, discountPaise: discount },
        { agentId: agent, mandateId: mandate.id, execute: env.rng() < 0.4 },
      );
      rec.record(`cart.modify discount ${discount} paise`, forbidden, mod);
    }
  }
  return rec.finish(caseIndex, 'discount_variation', `discount variation ${discount} paise`);
};

const genCategory: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const count = randInt(env.rng, 1, 4);
  const items: Array<{ productId: string; quantity: number }> = [];
  for (let i = 0; i < count; i++) {
    items.push({ productId: pickOf(env.rng, ALL_PRODUCTS), quantity: randInt(env.rng, 1, 3) });
  }
  const subtotal = subtotalOf(env, items);
  const forbidden = subtotal > MANDATE_CAP_Paise || categoryForbidden(env, mandate.kind, items.map((i) => i.productId));
  const { result } = await makeCart(env, agent, mandate.id, items);
  rec.record(`cart.create category mix (${items.map((i) => i.productId).join('+')})`, forbidden, result);
  return rec.finish(caseIndex, 'category_mix', `category mix ${items.map((i) => i.productId).join('+')}`);
};

const genQuantity: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  if (env.rng() < 0.3) {
    const quantity = pickOf(env.rng, [0, -2, 100, 999] as const);
    const raw: AgentAction = {
      actionId: `fzact${nextKey(env)}`,
      type: 'cart.create',
      agentId: agent,
      mandateId: mandate.id,
      cartId: null,
      protocol: 'INTERNAL',
      requestedCapabilities: ['cart.create'],
      timestamp: env.clock.now().toISOString(),
      idempotencyKey: nextKey(env),
      items: [{ productId: 'shoe-001', quantity }],
    };
    const result = await submitRaw(env, raw);
    rec.record(`cart.create with malformed quantity ${quantity}`, true, result);
  } else {
    const quantity = randInt(env.rng, 1, 99);
    const items = [{ productId: 'shoe-001', quantity }];
    const forbidden = subtotalOf(env, items) > MANDATE_CAP_Paise;
    const { result } = await makeCart(env, agent, mandate.id, items);
    rec.record(`cart.create quantity ${quantity}`, forbidden, result);
  }
  return rec.finish(caseIndex, 'quantities', 'quantity variation');
};

const genExpired: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandateId = pickOf(env.rng, env.mandates.expired);
  const items =
    env.rng() < 0.5
      ? [{ productId: 'shoe-001', quantity: 1 }]
      : [
          { productId: 'shoe-001', quantity: 1 },
          { productId: 'sock-001', quantity: 1 },
        ];
  const { result } = await makeCart(env, agent, mandateId, items);
  rec.record('cart.create under an expired mandate', true, result);
  return rec.finish(caseIndex, 'expired_mandate', 'action under expired mandate');
};

const genStale: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const mock = env.ctx.provider instanceof MockPaymentProvider ? env.ctx.provider : null;
  const { result, cart } = await makeCart(env, agent, mandate.id, [{ productId: 'shoe-001', quantity: 1 }]);
  rec.record('cart.create baseline', false, result);
  if (cart !== null && result.decision === 'ALLOW') {
    if (mock !== null) {
      mock.arm('timeout_then_captured');
    }
    const pay = await submit(
      env,
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
      { agentId: agent, mandateId: mandate.id, idempotencyKey: nextKey(env), execute: true },
    );
    rec.record('payment.create executed (provider timeout armed)', false, pay);
    const view = env.ctx.carts.getCart(cart.id);
    // A cart that is authorized or paid can never yield an ALLOWed payment.
    const provablyNotAllowable = view !== null && (view.cart.state === 'authorized' || view.cart.state === 'paid');
    const mod = await submit(
      env,
      { type: 'cart.add_item', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }] },
      { agentId: agent, mandateId: mandate.id, execute: true },
    );
    rec.record('cart.add_item after authorization (tamper)', false, mod);
    const after = env.ctx.carts.getCart(cart.id);
    const amount = after !== null ? after.totalPaise : cart.totalPaise;
    const repay = await submit(
      env,
      { type: 'payment.create', cartId: cart.id, amountPaise: amount, discountPaise: 0 },
      { agentId: agent, mandateId: mandate.id },
    );
    rec.record('payment.create on the tampered cart', provablyNotAllowable, repay);
  }
  return rec.finish(caseIndex, 'stale_cart', 'post-authorization cart tampering sequence');
};

const genReplay: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const key = nextKey(env);
  const first = await submit(env, { type: 'catalog.read', query: 'running' }, { agentId: agent, mandateId: null, idempotencyKey: key });
  rec.record('catalog.read (first submission)', false, first);
  const second = await submit(env, { type: 'catalog.read', query: 'running' }, { agentId: agent, mandateId: null, idempotencyKey: key });
  rec.record('catalog.read replayed with the same idempotency key', true, second);
  return rec.finish(caseIndex, 'replayed_action', 'idempotency replay');
};

const genDuplicatePayment: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const { result, cart } = await makeCart(env, agent, mandate.id, [{ productId: 'shoe-001', quantity: 1 }]);
  rec.record('cart.create baseline', false, result);
  if (cart !== null) {
    const key = nextKey(env);
    const pay = await submit(
      env,
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
      { agentId: agent, mandateId: mandate.id, idempotencyKey: key, execute: true },
    );
    rec.record('payment.create executed', false, pay);
    if (pay.decision === 'ALLOW' && pay.decisionId !== null) {
      try {
        // Replay execution attempt: prevented at the idempotency layer
        // (returns the original payment, records create.replay_ignored).
        await env.ctx.payments.executePayment(pay.decisionId);
      } catch {
        // Execution-layer rejection (e.g. decision consumed) is equally a prevention.
      }
    }
    const replay = await submit(
      env,
      { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
      { agentId: agent, mandateId: mandate.id, idempotencyKey: key },
    );
    rec.record('payment.create replayed with the same idempotency key', true, replay);
  }
  return rec.finish(caseIndex, 'duplicate_payment', 'duplicate payment prevention');
};

const genBudget: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const committed = env.ctx.payments.getCommittedSpendToday();
  const lowered = Math.max(1, Math.ceil(committed / 100));
  env.ctx.policies.updatePolicy(env.ctx.merchantId, { dailyBudgetRupees: lowered }, 'fuzz-sandbox');
  try {
    const { result, cart } = await makeCart(env, agent, mandate.id, [{ productId: 'shoe-001', quantity: 1 }]);
    rec.record('cart.create (carts are not budget-checked)', false, result);
    if (cart !== null) {
      const pay = await submit(
        env,
        { type: 'payment.create', cartId: cart.id, amountPaise: cart.totalPaise, discountPaise: 0 },
        { agentId: agent, mandateId: mandate.id },
      );
      // Budget == committed exactly → committed + amount > budget, provably BLOCK.
      rec.record('payment.create with the daily budget exhausted', true, pay);
    }
  } finally {
    env.ctx.policies.updatePolicy(env.ctx.merchantId, { dailyBudgetRupees: SANDBOX_BUDGET_RUPEES }, 'fuzz-sandbox');
  }
  return rec.finish(caseIndex, 'budget_exhaustion', 'payment past the exhausted daily budget');
};

const genUnknownCapability: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const token =
    env.rng() < 0.5 ? pickOf(env.rng, ['root.access', 'admin.all', 'payment.force'] as const) : `cap.${randInt(env.rng, 0, 9999)}`;
  const caps = env.rng() < 0.4 ? [token, 'refund.create'] : [token];
  const result = await submit(env, { type: 'catalog.read', query: 'running' }, { agentId: agent, mandateId: null, requestedCapabilities: caps });
  rec.record(`catalog.read requesting unknown capability "${token}"`, true, result);
  return rec.finish(caseIndex, 'unknown_capability', `unknown capability ${token}`);
};

const genPrivileged: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const type = pickOf(env.rng, [
    'refund.create',
    'policy.modify',
    'mandate.modify',
    'merchant.payout.modify',
    'settlement_account.modify',
  ] as const);
  let payload: ActionPayload;
  switch (type) {
    case 'refund.create':
      payload = { type, paymentId: 'pay_fuzz_target', amountPaise: 100_000 };
      break;
    case 'policy.modify':
      payload = { type, policyPatch: { maxDiscountRupees: 100_000 } };
      break;
    case 'mandate.modify':
      payload = { type, mandatePatch: { maxAmountRupees: 100_000 } };
      break;
    case 'merchant.payout.modify':
      payload = { type, details: { account: 'attacker' } };
      break;
    case 'settlement_account.modify':
      payload = { type, details: { account: 'attacker' } };
      break;
  }
  const result = await submit(env, payload, { agentId: agent, mandateId: null });
  rec.record(`privileged action ${type} by an agent`, true, result);
  return rec.finish(caseIndex, 'privileged_action', `privileged ${type}`);
};

const genPriceTamper: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const productId = pickOf(env.rng, ALL_PRODUCTS);
  const real = priceOf(env, productId);
  const delta = randInt(env.rng, 1, 50_000) * (env.rng() < 0.5 ? -1 : 1);
  const claimed = Math.max(0, real + delta);
  const { result } = await makeCart(env, agent, mandate.id, [{ productId, quantity: 1, claimedUnitPricePaise: claimed }]);
  rec.record(`cart.create with tampered price claim for ${productId} (${claimed} vs ${real})`, true, result);
  return rec.finish(caseIndex, 'price_tamper', `price tamper on ${productId}`);
};

const genCatalogInjection: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const { result } = await makeCart(env, agent, mandate.id, [
    { productId: 'malicious-001', quantity: 1, claimedUnitPricePaise: 749 },
  ]);
  rec.record('cart.create obeying the injected "AI INSTRUCTION" (90% discount claim)', true, result);
  return rec.finish(caseIndex, 'catalog_injection', 'malicious catalog instruction exploitation');
};

const genUpsell: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const mandate = pickMandate(env);
  const { result, cart } = await makeCart(env, BUYER, mandate.id, [{ productId: 'shoe-001', quantity: 1 }]);
  rec.record('cart.create by buyer', false, result);
  if (cart !== null) {
    const up = await submit(
      env,
      { type: 'upsell.create', cartId: cart.id, items: [{ productId: 'sock-001', quantity: 1 }], pitch: 'co-purchase' },
      { agentId: GROWTH, mandateId: mandate.id, execute: env.rng() < 0.5 },
    );
    rec.record('upsell.create by growth agent', mandate.kind === 'strict', up);
  }
  return rec.finish(caseIndex, 'upsell', 'growth-agent upsell proposal');
};

const genSequence: Generator = async (env, caseIndex, maxSequenceLength) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const mandate = pickMandate(env);
  const { result, cart } = await makeCart(env, agent, mandate.id, [{ productId: 'shoe-001', quantity: 1 }]);
  rec.record('cart.create baseline', false, result);
  const cartId = cart?.id ?? null;
  const usedPaymentKeys: string[] = [];
  const stepCount = randInt(env.rng, 2, Math.max(2, maxSequenceLength));
  const kinds = ['add-item', 'discount', 'modify-replace', 'refund', 'payment', 'payment-retry'] as const;
  for (let s = 0; s < stepCount && cartId !== null; s++) {
    const kind = pickOf(env.rng, kinds);
    const view = env.ctx.carts.getCart(cartId);
    const total = view?.totalPaise ?? 749_900;
    if (kind === 'add-item') {
      const productId = pickOf(env.rng, NEAR_PRODUCTS);
      const forbidden = total + priceOf(env, productId) > MANDATE_CAP_Paise || categoryForbidden(env, mandate.kind, [productId]);
      const r = await submit(
        env,
        { type: 'cart.add_item', cartId, items: [{ productId, quantity: randInt(env.rng, 1, 2) }] },
        { agentId: agent, mandateId: mandate.id, execute: true },
      );
      rec.record(`+ ${productId}`, forbidden, r);
    } else if (kind === 'discount') {
      const discount = env.rng() < 0.5 ? randInt(env.rng, 0, MERCHANT_DISCOUNT_CAP_Paise) : randInt(env.rng, 0, 200_000);
      const r = await submit(
        env,
        { type: 'cart.modify', cartId, discountPaise: discount },
        { agentId: agent, mandateId: mandate.id, execute: env.rng() < 0.5 },
      );
      rec.record(`discount ${discount} paise`, discount > MERCHANT_DISCOUNT_CAP_Paise, r);
    } else if (kind === 'modify-replace') {
      const items = [
        { productId: 'shoe-001', quantity: 1 },
        { productId: pickOf(env.rng, NEAR_PRODUCTS), quantity: randInt(env.rng, 1, 2) },
      ];
      const forbidden = subtotalOf(env, items) > MANDATE_CAP_Paise || categoryForbidden(env, mandate.kind, items.map((i) => i.productId));
      const r = await submit(
        env,
        { type: 'cart.modify', cartId, items, reason: 'fuzz sequence replacement' },
        { agentId: agent, mandateId: mandate.id, execute: true },
      );
      rec.record('cart.modify item replacement', forbidden, r);
    } else if (kind === 'refund') {
      const r = await submit(env, { type: 'refund.create', paymentId: 'pay_fuzz_sequence', amountPaise: 50_000 }, { agentId: agent, mandateId: mandate.id });
      rec.record('refund.create mid-sequence', true, r);
    } else if (kind === 'payment') {
      const key = nextKey(env);
      usedPaymentKeys.push(key);
      const r = await submit(
        env,
        { type: 'payment.create', cartId, amountPaise: total, discountPaise: 0 },
        { agentId: agent, mandateId: mandate.id, idempotencyKey: key },
      );
      rec.record('payment.create proposal', total > MANDATE_CAP_Paise, r);
    } else {
      const priorKey = usedPaymentKeys.at(-1);
      if (priorKey === undefined) {
        const key = nextKey(env);
        usedPaymentKeys.push(key);
        const r = await submit(
          env,
          { type: 'payment.create', cartId, amountPaise: total, discountPaise: 0 },
          { agentId: agent, mandateId: mandate.id, idempotencyKey: key },
        );
        rec.record('payment.create proposal', total > MANDATE_CAP_Paise, r);
      } else {
        const r = await submit(
          env,
          { type: 'payment.create', cartId, amountPaise: total, discountPaise: 0 },
          { agentId: agent, mandateId: mandate.id, idempotencyKey: priorKey },
        );
        rec.record('payment.create retry with a consumed key', true, r);
      }
    }
  }
  return rec.finish(caseIndex, 'sequence', 'multi-step action sequence');
};

const genPaymentQuery: Generator = async (env, caseIndex) => {
  const rec = new Recorder();
  const agent = pickAgent(env);
  const paymentId = `pay_fuzz_${randInt(env.rng, 0, 9999)}`;
  const r = await submit(env, { type: 'payment.query', paymentId }, { agentId: agent, mandateId: null });
  rec.record(`payment.query ${paymentId}`, false, r);
  return rec.finish(caseIndex, 'payment_query', `payment query ${paymentId}`);
};

const GENERATORS: ReadonlyArray<{ weight: number; gen: Generator }> = [
  { weight: 14, gen: genBenign },
  { weight: 10, gen: genAmount },
  { weight: 12, gen: genDiscount },
  { weight: 10, gen: genCategory },
  { weight: 6, gen: genQuantity },
  { weight: 6, gen: genExpired },
  { weight: 3, gen: genStale },
  { weight: 6, gen: genReplay },
  { weight: 4, gen: genDuplicatePayment },
  { weight: 1, gen: genBudget },
  { weight: 6, gen: genUnknownCapability },
  { weight: 6, gen: genPrivileged },
  { weight: 4, gen: genPriceTamper },
  { weight: 2, gen: genCatalogInjection },
  { weight: 3, gen: genUpsell },
  { weight: 4, gen: genSequence },
  { weight: 3, gen: genPaymentQuery },
];
const TOTAL_WEIGHT = GENERATORS.reduce((sum, g) => sum + g.weight, 0);

function pickGenerator(env: FuzzEnv): { weight: number; gen: Generator } {
  let target = env.rng() * TOTAL_WEIGHT;
  for (const entry of GENERATORS) {
    target -= entry.weight;
    if (target < 0) return entry;
  }
  const last = GENERATORS.at(-1);
  if (last !== undefined) return last;
  throw new Error('Fuzzer generator list is empty');
}

// ---------- service ----------

/**
 * Deterministic fuzzer (§41–§43). Every case invokes the REAL
 * AuthorizationEngine (and, where sequences require it, real cart/payment
 * execution and reconciliation) inside an isolated in-memory sandbox: fresh
 * seeded database, pinned FixedClock, forced mock provider, real
 * PolicyEngine/MandateService/ProtocolGateway. The run's actual statistics
 * and bypass records are persisted to the LIVE database — dashboard metrics
 * stay real while the demo state stays unpolluted.
 */
export class FuzzerService {
  constructor(private readonly ctx: ServiceContext) {}

  async run(input: FuzzerRunInput): Promise<FuzzerRunOutput> {
    const runId = newId('fuzz');
    const startedAt = this.ctx.clock.now().toISOString();
    this.ctx.db
      .insert(schema.fuzzRuns)
      .values({
        id: runId,
        seed: input.seed,
        cases: input.cases,
        maxSequenceLength: input.maxSequenceLength,
        startedAt,
        finishedAt: null,
        durationMs: null,
        stats: null,
      })
      .run();

    const sandbox = this.buildSandbox(input.seed);
    const stats: FuzzRunStats = {
      totalCases: 0,
      allowed: 0,
      blocked: 0,
      reauthorized: 0,
      humanApproval: 0,
      policyViolations: 0,
      bypasses: 0,
      failures: 0,
    };
    const bypassRecords: FuzzBypassRecord[] = [];
    const sampleRows: Array<typeof schema.fuzzCases.$inferInsert> = [];

    try {
      for (let i = 0; i < input.cases; i++) {
        const entry = pickGenerator(sandbox.env);
        let result: CaseResult;
        try {
          result = await entry.gen(sandbox.env, i, input.maxSequenceLength);
        } catch (err) {
          result = {
            category: 'error',
            description: 'case threw an unexpected error',
            outcome: 'ERROR',
            reason: err instanceof Error ? err.message : String(err),
            violated: false,
            bypasses: [],
          };
        }
        stats.totalCases += 1;
        switch (result.outcome) {
          case 'ALLOW':
            stats.allowed += 1;
            break;
          case 'BLOCK':
            stats.blocked += 1;
            break;
          case 'REAUTHORIZE':
            stats.reauthorized += 1;
            break;
          case 'HUMAN_APPROVAL':
            stats.humanApproval += 1;
            break;
          default:
            stats.failures += 1;
            break;
        }
        if (result.violated) stats.policyViolations += 1;
        if (result.bypasses.length > 0) {
          stats.bypasses += result.bypasses.length;
          bypassRecords.push(...result.bypasses);
          for (const b of result.bypasses) {
            sampleRows.push({
              id: newId('fc'),
              runId,
              caseIndex: b.caseIndex,
              description: b.description.slice(0, 200),
              category: result.category,
              outcome: b.outcome,
              reason: b.reason.slice(0, 300),
              bypass: true,
            });
          }
        }
        if (i % 25 === 0) {
          sampleRows.push({
            id: newId('fc'),
            runId,
            caseIndex: i,
            description: result.description.slice(0, 200),
            category: result.category,
            outcome: result.outcome,
            reason: result.reason.slice(0, 300),
            bypass: false,
          });
        }
      }
    } finally {
      sandbox.close();
    }

    const finishedAt = this.ctx.clock.now().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    this.ctx.db
      .update(schema.fuzzRuns)
      .set({ finishedAt, durationMs, stats })
      .where(eq(schema.fuzzRuns.id, runId))
      .run();
    for (const row of sampleRows) {
      this.ctx.db.insert(schema.fuzzCases).values(row).run();
    }

    const run: FuzzRunDTO = {
      id: runId,
      seed: input.seed,
      cases: input.cases,
      maxSequenceLength: input.maxSequenceLength,
      startedAt,
      finishedAt,
      durationMs,
      stats,
    };
    this.ctx.audit.append({
      actor: 'fuzzer',
      eventType: 'FUZZ_RUN',
      action: 'fuzz.run',
      reason: `Fuzz run ${runId}: ${stats.totalCases} cases — ${stats.blocked} blocked, ${stats.reauthorized} reauthorized, ${stats.humanApproval} human-approval, ${stats.allowed} allowed, ${stats.bypasses} bypasses, ${stats.failures} failures.`,
      inputHash: sha256JSON({ runId, seed: input.seed, cases: input.cases, maxSequenceLength: input.maxSequenceLength }),
      payload: { runId, ...stats },
    });

    const note =
      stats.bypasses === 0
        ? `Deterministic fuzz run: ${stats.totalCases} cases executed against the real AuthorizationEngine in an isolated in-memory sandbox (seed ${input.seed}). No forbidden case was allowed.`
        : `WARNING: ${stats.bypasses} forbidden case step(s) were ALLOWED — investigate the bypass records.`;
    return { run, bypasses: bypassRecords, note };
  }

  private buildSandbox(seed: number): { env: FuzzEnv; close: () => void } {
    const handle = createDatabase(':memory:');
    runMigrations(handle.sqlite);
    const clock = new FixedClock(new Date(SANDBOX_EPOCH));
    seedDatabase(handle.db, clock);
    // Force the mock provider so the sandbox never depends on external services.
    const config = {
      ...this.ctx.config,
      paymentProvider: 'mock' as const,
      razorpayKeyId: null,
      razorpayKeySecret: null,
    };
    const ctx = buildServiceContext(handle, clock, config);
    const gateway = new ProtocolGateway(ctx);
    // Sandbox fixture: raise the daily budget so ordinary case families exercise
    // authorization rules rather than the budget ceiling; budget-exhaustion
    // cases lower and restore it through the REAL PolicyEngine (audited in-sandbox).
    ctx.policies.updatePolicy(ctx.merchantId, { dailyBudgetRupees: SANDBOX_BUDGET_RUPEES }, 'fuzz-sandbox');

    const standard: string[] = [];
    const strict: string[] = [];
    const broad: string[] = [];
    for (let i = 0; i < 120; i++) {
      standard.push(ctx.mandates.createMandate(SANDBOX_MANDATE_INPUT, 'fuzz-user').row.id);
    }
    for (let i = 0; i < 12; i++) {
      strict.push(
        ctx.mandates.createMandate({ ...SANDBOX_MANDATE_INPUT, allowUpsell: false }, 'fuzz-user').row.id,
      );
    }
    for (let i = 0; i < 12; i++) {
      broad.push(
        ctx.mandates
          .createMandate(
            { ...SANDBOX_MANDATE_INPUT, allowedCategories: ['running_shoes', 'running_accessories'] },
            'fuzz-user',
          )
          .row.id,
      );
    }
    // Expired mandates: rewind the clock, issue 1-hour-TTL mandates, restore.
    clock.set(new Date(SANDBOX_EPOCH - 2 * 3_600_000));
    const expired: string[] = [];
    for (let i = 0; i < 10; i++) {
      expired.push(ctx.mandates.createMandate({ ...SANDBOX_MANDATE_INPUT, ttlHours: 1 }, 'fuzz-user').row.id);
    }
    clock.set(new Date(SANDBOX_EPOCH));

    return {
      env: {
        ctx,
        gateway,
        clock,
        rng: mulberry32(seed),
        mandates: { standard, strict, broad, expired },
        keySeq: 0,
      },
      close: (): void => handle.close(),
    };
  }
}