// apps/api/src/db/schema.ts
//
// NOTE ON INDEXES: this file declares tables and columns only. Every index and
// unique constraint lives in apps/api/drizzle/*.sql, and several are
// load-bearing rather than performance hints:
//   payments_idempotency_key_idx      payment replay protection
//   audit_events_sequence_idx         audit chain integrity
//   payment_events_key_idx            provider webhook dedupe
//   cart_items_cart_product_idx       the add-item upsert
//   human_approvals_decision_idx      one review per decision
//   drift_sessions_open_idx           the partial index behind session lookup
// drizzle-kit is deliberately NOT a dependency; the migrations are hand-written
// and hash-verified. If you ever add `drizzle-kit generate`/`push`, port these
// index declarations into this file FIRST — generating DDL from this file as it
// stands would silently drop all of them.
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AgentType,
  AuditEventType,
  CartItemSource,
  CartState,
  Category,
  Decision,
  DecisionReceipt,
  DriftBreakdown,
  FuzzRunStats,
  GrowthOpportunityStatus,
  GrowthStats,
  HumanApprovalOutcome,
  MandateStatus,
  OrderStatus,
  PaymentProviderName,
  PaymentState,
  ProtocolName,
  ProtocolRequestStatus,
  RuleViolation,
} from '@acsf/shared';

export const merchants = sqliteTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const policies = sqliteTable('policies', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id')
    .notNull()
    .references(() => merchants.id),
  version: integer('version').notNull(),
  maxOrderAmountPaise: integer('max_order_amount_paise').notNull(),
  maxDiscountPaise: integer('max_discount_paise').notNull(),
  maxRefundPaise: integer('max_refund_paise').notNull(),
  dailyBudgetPaise: integer('daily_budget_paise').notNull(),
  allowUpsells: integer('allow_upsells', { mode: 'boolean' }).notNull(),
  allowCartModification: integer('allow_cart_modification', { mode: 'boolean' }).notNull(),
  requireApprovalAboveDrift: real('require_approval_above_drift').notNull(),
  blockAboveDrift: real('block_above_drift').notNull(),
  authorizationTtlMinutes: integer('authorization_ttl_minutes').notNull(),
  minimumMarginPercent: integer('minimum_margin_percent').notNull(),
  allowedCapabilities: text('allowed_capabilities', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  agentType: text('agent_type').$type<AgentType>().notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const mandates = sqliteTable('mandates', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  intent: text('intent').notNull(),
  maxAmountPaise: integer('max_amount_paise').notNull(),
  allowedCategories: text('allowed_categories', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
  allowUpsell: integer('allow_upsell', { mode: 'boolean' }).notNull(),
  version: integer('version').notNull(),
  status: text('status').$type<MandateStatus>().notNull(),
  issuedAt: text('issued_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  supersedesId: text('supersedes_id'),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id')
    .notNull()
    .references(() => merchants.id),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  pricePaise: integer('price_paise').notNull(),
  category: text('category').$type<Category>().notNull(),
  marginPercent: integer('margin_percent').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  malicious: integer('malicious', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const driftSessions = sqliteTable('drift_sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  mandateId: text('mandate_id')
    .notNull()
    .references(() => mandates.id),
  protocol: text('protocol').$type<ProtocolName>().notNull(),
  actionCount: integer('action_count').notNull(),
  scopeExpandingActions: integer('scope_expanding_actions').notNull(),
  nonCoreSpendPaise: integer('non_core_spend_paise').notNull(),
  sessionDiscountPaise: integer('session_discount_paise').notNull(),
  sessionItemDistances: text('session_item_distances', { mode: 'json' })
    .$type<number[]>()
    .notNull(),
  currentBreakdown: text('current_breakdown', { mode: 'json' }).$type<DriftBreakdown>(),
  startedAt: text('started_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  closedAt: text('closed_at'),
});

export const carts = sqliteTable('carts', {
  id: text('id').primaryKey(),
  mandateId: text('mandate_id')
    .notNull()
    .references(() => mandates.id),
  agentId: text('agent_id').notNull(),
  state: text('state').$type<CartState>().notNull(),
  discountPaise: integer('discount_paise').notNull().default(0),
  authorizedHash: text('authorized_hash'),
  currentHash: text('current_hash'),
  authorizationId: text('authorization_id'),
  authorizationExpiresAt: text('authorization_expires_at'),
  protocol: text('protocol').$type<ProtocolName>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const cartItems = sqliteTable('cart_items', {
  id: text('id').primaryKey(),
  cartId: text('cart_id')
    .notNull()
    .references(() => carts.id),
  productId: text('product_id')
    .notNull()
    .references(() => products.id),
  quantity: integer('quantity').notNull(),
  unitPricePaise: integer('unit_price_paise').notNull(),
  // Frozen with the line, like the price. Reading it live let a later catalog
  // edit rewrite the margin reported for historical sales.
  marginPercent: integer('margin_percent').notNull().default(0),
  options: text('options', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  source: text('source').$type<CartItemSource>().notNull(),
  createdAt: text('created_at').notNull(),
});

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  cartId: text('cart_id')
    .notNull()
    .references(() => carts.id),
  mandateId: text('mandate_id')
    .notNull()
    .references(() => mandates.id),
  agentId: text('agent_id').notNull(),
  status: text('status').$type<OrderStatus>().notNull(),
  totalPaise: integer('total_paise').notNull(),
  productIds: text('product_ids', { mode: 'json' }).$type<string[]>().notNull(),
  protocol: text('protocol').$type<ProtocolName>().notNull(),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
});

export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  orderId: text('order_id').references(() => orders.id),
  decisionId: text('decision_id'),
  agentId: text('agent_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  provider: text('provider').$type<PaymentProviderName>().notNull(),
  providerPaymentId: text('provider_payment_id'),
  state: text('state').$type<PaymentState>().notNull(),
  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  duplicate: integer('duplicate', { mode: 'boolean' }).notNull().default(false),
  reconciled: integer('reconciled', { mode: 'boolean' }).notNull().default(false),
  failureReason: text('failure_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const paymentEvents = sqliteTable('payment_events', {
  id: text('id').primaryKey(),
  paymentId: text('payment_id')
    .notNull()
    .references(() => payments.id),
  eventKey: text('event_key').notNull(),
  event: text('event').notNull(),
  state: text('state').$type<PaymentState>(),
  detail: text('detail').notNull(),
  duplicate: integer('duplicate', { mode: 'boolean' }).notNull().default(false),
  ignored: integer('ignored', { mode: 'boolean' }).notNull().default(false),
  at: text('at').notNull(),
});

export const authorizationDecisions = sqliteTable('authorization_decisions', {
  id: text('id').primaryKey(),
  actionId: text('action_id').notNull(),
  sessionId: text('session_id').references(() => driftSessions.id),
  agentId: text('agent_id').notNull(),
  mandateId: text('mandate_id').references(() => mandates.id),
  mandateVersion: integer('mandate_version'),
  policyVersion: integer('policy_version').notNull(),
  cartId: text('cart_id'),
  cartHash: text('cart_hash'),
  protocol: text('protocol').$type<ProtocolName>().notNull(),
  actionType: text('action_type').notNull(),
  actionSummary: text('action_summary').notNull(),
  amountPaise: integer('amount_paise'),
  decision: text('decision').$type<Decision>().notNull(),
  reason: text('reason').notNull(),
  violations: text('violations', { mode: 'json' }).$type<RuleViolation[]>().notNull(),
  drift: text('drift', { mode: 'json' }).$type<DriftBreakdown>(),
  receipt: text('receipt', { mode: 'json' }).$type<DecisionReceipt>().notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  approvalId: text('approval_id'),
  approvedAt: text('approved_at'),
  consumedAt: text('consumed_at'),
  createdAt: text('created_at').notNull(),
});

export const humanApprovals = sqliteTable('human_approvals', {
  id: text('id').primaryKey(),
  decisionId: text('decision_id')
    .notNull()
    .references(() => authorizationDecisions.id),
  approvedBy: text('approved_by').notNull(),
  outcome: text('outcome').$type<HumanApprovalOutcome>().notNull(),
  note: text('note'),
  createdAt: text('created_at').notNull(),
});

export const auditEvents = sqliteTable('audit_events', {
  eventId: text('event_id').primaryKey(),
  sequence: integer('sequence').notNull(),
  timestamp: text('timestamp').notNull(),
  actor: text('actor').notNull(),
  eventType: text('event_type').$type<AuditEventType>().notNull(),
  action: text('action'),
  decision: text('decision').$type<Decision>(),
  reason: text('reason'),
  inputHash: text('input_hash').notNull(),
  policyVersion: integer('policy_version'),
  previousEventHash: text('previous_event_hash'),
  eventHash: text('event_hash').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
});

/**
 * Single-row anchor recording where the audit chain is supposed to end.
 * Written inside the same transaction as every append; verifyChain() compares
 * the last event against it, which is what makes tail truncation detectable.
 */
export const auditChainHead = sqliteTable('audit_chain_head', {
  id: text('id').primaryKey(),
  sequence: integer('sequence').notNull(),
  eventHash: text('event_hash').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const fuzzRuns = sqliteTable('fuzz_runs', {
  id: text('id').primaryKey(),
  seed: integer('seed').notNull(),
  cases: integer('cases').notNull(),
  maxSequenceLength: integer('max_sequence_length').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  durationMs: integer('duration_ms'),
  stats: text('stats', { mode: 'json' }).$type<FuzzRunStats>(),
});

export const fuzzCases = sqliteTable('fuzz_cases', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => fuzzRuns.id),
  caseIndex: integer('case_index').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  outcome: text('outcome').notNull(),
  reason: text('reason').notNull(),
  bypass: integer('bypass', { mode: 'boolean' }).notNull().default(false),
});

export const growthOpportunities = sqliteTable('growth_opportunities', {
  id: text('id').primaryKey(),
  type: text('type').$type<'upsell' | 'cross_sell' | 'bundle'>().notNull(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id),
  anchorProductId: text('anchor_product_id')
    .notNull()
    .references(() => products.id),
  amountPaise: integer('amount_paise').notNull(),
  reason: text('reason').notNull(),
  confidence: real('confidence').notNull(),
  stats: text('stats', { mode: 'json' }).$type<GrowthStats>(),
  status: text('status').$type<GrowthOpportunityStatus>().notNull(),
  decision: text('decision').$type<Decision>(),
  decisionId: text('decision_id'),
  proposedBy: text('proposed_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const protocolRequests = sqliteTable('protocol_requests', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  protocol: text('protocol').$type<ProtocolName>().notNull(),
  tool: text('tool').notNull(),
  agentId: text('agent_id').notNull(),
  status: text('status').$type<ProtocolRequestStatus>().notNull(),
  decision: text('decision').$type<Decision>(),
  decisionId: text('decision_id'),
  summary: text('summary').notNull(),
  createdAt: text('created_at').notNull(),
});

// ---- Row types used across services ----
export type MerchantRow = typeof merchants.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type MandateRow = typeof mandates.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type DriftSessionRow = typeof driftSessions.$inferSelect;
export type CartRow = typeof carts.$inferSelect;
export type CartItemRow = typeof cartItems.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type PaymentEventRow = typeof paymentEvents.$inferSelect;
export type AuthorizationDecisionRow = typeof authorizationDecisions.$inferSelect;
export type HumanApprovalRow = typeof humanApprovals.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type FuzzRunRow = typeof fuzzRuns.$inferSelect;
export type FuzzCaseRow = typeof fuzzCases.$inferSelect;
export type GrowthOpportunityRow = typeof growthOpportunities.$inferSelect;
export type ProtocolRequestRow = typeof protocolRequests.$inferSelect;