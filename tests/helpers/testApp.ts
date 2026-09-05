// tests/helpers/testApp.ts
import type { FastifyInstance } from 'fastify';
import type { CartDTO, Category, PaymentDTO } from '@acsf/shared';
import type { AppContext } from '../../apps/api/src/appContext';
import { buildAppContext } from '../../apps/api/src/appContext';
import { buildApp } from '../../apps/api/src/app';
import { buildServiceContext } from '../../apps/api/src/context';
import type { AppConfig } from '../../apps/api/src/config';
import { createDatabase, type DatabaseHandle } from '../../apps/api/src/db/client';
import { runMigrations } from '../../apps/api/src/db/migrate';
import { seedDatabase } from '../../apps/api/src/db/seed';
import { MockPaymentProvider } from '../../apps/api/src/providers/MockPaymentProvider';
import type { GatewayResult } from '../../apps/api/src/protocol/ProtocolGateway';
import { FixedClock } from '../../apps/api/src/utils/clock';

export const TEST_EPOCH = Date.parse('2025-06-01T10:00:00.000Z');

export interface TestApp {
  ctx: AppContext;
  clock: FixedClock;
  close(): void;
}

export interface TestServer extends TestApp {
  app: FastifyInstance;
  close(): Promise<void>;
}

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
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
  };
}

function buildFreshHandle(clock: FixedClock): DatabaseHandle {
  const handle = createDatabase(':memory:');
  runMigrations(handle.sqlite);
  seedDatabase(handle.db, clock);
  return handle;
}

/** Fresh in-memory app: migrated, seeded, FixedClock-pinned (§67, §68). */
export function createTestApp(): TestApp {
  const clock = new FixedClock(new Date(TEST_EPOCH));
  const handle = buildFreshHandle(clock);
  const ctx = buildAppContext(buildServiceContext(handle, clock, testConfig()), handle);
  return { ctx, clock, close: () => handle.close() };
}

/** TestApp + a real Fastify instance for HTTP-level (app.inject) tests. */
export async function createTestServer(): Promise<TestServer> {
  const clock = new FixedClock(new Date(TEST_EPOCH));
  const handle = buildFreshHandle(clock);
  const ctx = buildAppContext(buildServiceContext(handle, clock, testConfig()), handle);
  const app = await buildApp(ctx);
  return {
    ctx,
    clock,
    app,
    close: async () => {
      await app.close();
      handle.close();
    },
  };
}

export function mockProvider(ctx: AppContext): MockPaymentProvider {
  if (!(ctx.provider instanceof MockPaymentProvider)) {
    throw new Error('This test requires the mock payment provider.');
  }
  return ctx.provider;
}

export interface MandateOverrides {
  maxAmountRupees?: number;
  allowedCategories?: Category[];
  allowUpsell?: boolean;
  ttlHours?: number;
  userId?: string;
}

/** Issues a fresh mandate (⇒ fresh drift session per (agent, mandate)). */
export function createStandardMandate(ctx: AppContext, overrides: MandateOverrides = {}): string {
  const userId = overrides.userId ?? 'test-user';
  const view = ctx.mandates.createMandate(
    {
      userId,
      intent: 'I need running shoes for marathon training under ₹8,000',
      maxAmountRupees: overrides.maxAmountRupees ?? 8_000,
      allowedCategories: overrides.allowedCategories ?? ['running_shoes'],
      allowUpsell: overrides.allowUpsell ?? true,
      ttlHours: overrides.ttlHours ?? 24,
    },
    userId,
  );
  return view.row.id;
}

export interface ItemInput {
  productId: string;
  quantity: number;
  claimedUnitPricePaise?: number;
}

/** Creates a cart through the gateway (real engine evaluation + execution). */
export async function createCart(
  ctx: AppContext,
  agentId: string,
  mandateId: string,
  items: ItemInput[],
): Promise<CartDTO> {
  const result = await ctx.gateway.submitPayload(
    { type: 'cart.create', items },
    { agentId, mandateId, protocol: 'INTERNAL' },
    { execute: true },
  );
  if (result.decision !== 'ALLOW' || result.data === null) {
    throw new Error(`cart.create was ${result.decision ?? 'ERROR'}: ${result.reason ?? result.error?.message ?? 'unknown'}`);
  }
  return result.data as CartDTO;
}

export interface PaymentOpts {
  discountPaise?: number;
  idempotencyKey?: string;
  execute?: boolean;
}

/** Payment.create proposal through the gateway; amount derived server-side from the cart. */
export async function proposePayment(
  ctx: AppContext,
  agentId: string,
  mandateId: string,
  cartId: string,
  opts: PaymentOpts = {},
): Promise<GatewayResult> {
  const view = ctx.carts.getCart(cartId);
  if (view === null) throw new Error(`Cart ${cartId} not found.`);
  const discount = opts.discountPaise ?? 0;
  return ctx.gateway.submitPayload(
    { type: 'payment.create', cartId, amountPaise: view.subtotalPaise - discount, discountPaise: discount },
    { agentId, mandateId, protocol: 'INTERNAL', idempotencyKey: opts.idempotencyKey },
    { execute: opts.execute ?? false },
  );
}

/** Full guarded payment execution (asserts ALLOW; returns the payment in its actual state). */
export async function payCart(
  ctx: AppContext,
  agentId: string,
  mandateId: string,
  cartId: string,
  opts: PaymentOpts = {},
): Promise<PaymentDTO> {
  const result = await proposePayment(ctx, agentId, mandateId, cartId, { ...opts, execute: true });
  if (result.decision !== 'ALLOW' || result.data === null) {
    throw new Error(`payment.create was ${result.decision ?? 'ERROR'}: ${result.reason ?? result.error?.message ?? 'unknown'}`);
  }
  return result.data as PaymentDTO;
}