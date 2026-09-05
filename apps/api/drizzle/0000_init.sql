-- apps/api/drizzle/0000_init.sql
-- Agentic Commerce Firewall — initial schema.
-- Money is integer paise. Timestamps are ISO-8601 UTC strings.
-- Policies and mandates are immutable, versioned rows: history is never rewritten.

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  version INTEGER NOT NULL,
  max_order_amount_paise INTEGER NOT NULL,
  max_discount_paise INTEGER NOT NULL,
  max_refund_paise INTEGER NOT NULL,
  daily_budget_paise INTEGER NOT NULL,
  allow_upsells INTEGER NOT NULL,
  allow_cart_modification INTEGER NOT NULL,
  require_approval_above_drift REAL NOT NULL,
  block_above_drift REAL NOT NULL,
  authorization_ttl_minutes INTEGER NOT NULL,
  minimum_margin_percent INTEGER NOT NULL,
  allowed_capabilities TEXT NOT NULL,          -- JSON: string[]
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX policies_merchant_version_idx ON policies(merchant_id, version);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  capabilities TEXT NOT NULL,                  -- JSON: string[] (grantable capabilities only)
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE mandates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  max_amount_paise INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL,            -- JSON: string[]
  allow_upsell INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,                        -- active | superseded | expired
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  supersedes_id TEXT REFERENCES mandates(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mandates_user_idx ON mandates(user_id);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,                   -- UNTRUSTED text: data, never instructions
  price_paise INTEGER NOT NULL,
  category TEXT NOT NULL,
  margin_percent INTEGER NOT NULL,
  active INTEGER NOT NULL,
  malicious INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX products_merchant_idx ON products(merchant_id);
CREATE INDEX products_category_idx ON products(category);

CREATE TABLE drift_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  protocol TEXT NOT NULL,
  action_count INTEGER NOT NULL,
  scope_expanding_actions INTEGER NOT NULL,
  non_core_spend_paise INTEGER NOT NULL,
  session_discount_paise INTEGER NOT NULL,
  session_item_distances TEXT NOT NULL DEFAULT '[]',  -- JSON: number[] (executed items)
  current_breakdown TEXT,                              -- JSON: DriftBreakdown (nullable)
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX drift_sessions_open_idx
  ON drift_sessions(agent_id, mandate_id) WHERE closed_at IS NULL;

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,                         -- open | authorized | paid | stale
  discount_paise INTEGER NOT NULL DEFAULT 0,
  authorized_hash TEXT,
  current_hash TEXT,
  authorization_id TEXT,
  authorization_expires_at TEXT,
  protocol TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price_paise INTEGER NOT NULL,           -- resolved server-side from products.price_paise
  options TEXT NOT NULL DEFAULT '{}',          -- JSON: Record<string,string> (canonical hash input)
  source TEXT NOT NULL,                        -- buyer | growth | attack | fuzz | history
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cart_items_cart_product_idx ON cart_items(cart_id, product_id);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,                        -- pending | completed | failed
  total_paise INTEGER NOT NULL,
  product_ids TEXT NOT NULL,                   -- JSON: string[]
  protocol TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX orders_cart_idx ON orders(cart_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  decision_id TEXT,                            -- ALLOW decision that authorized this payment
  agent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider TEXT NOT NULL,                      -- mock | razorpay
  provider_payment_id TEXT,
  state TEXT NOT NULL,                         -- CREATED..REFUNDED
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  duplicate INTEGER NOT NULL DEFAULT 0,        -- true when this create was deduplicated
  reconciled INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX payments_idempotency_key_idx ON payments(idempotency_key);
CREATE INDEX payments_order_idx ON payments(order_id);
CREATE INDEX payments_state_idx ON payments(state);

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  event_key TEXT NOT NULL,                     -- provider dedupe key (providerPaymentId:eventName)
  event TEXT NOT NULL,
  state TEXT,                                  -- resulting PaymentState, if any
  detail TEXT NOT NULL,
  duplicate INTEGER NOT NULL DEFAULT 0,        -- provider event replay
  ignored INTEGER NOT NULL DEFAULT 0,          -- invalid transition / out-of-order event
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX payment_events_key_idx ON payment_events(event_key);
CREATE INDEX payment_events_payment_idx ON payment_events(payment_id);

CREATE TABLE authorization_decisions (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  session_id TEXT REFERENCES drift_sessions(id),
  agent_id TEXT NOT NULL,
  mandate_id TEXT REFERENCES mandates(id),
  mandate_version INTEGER,
  policy_version INTEGER NOT NULL,             -- snapshots the policy used (0 = not evaluated)
  cart_id TEXT,
  cart_hash TEXT,
  protocol TEXT NOT NULL,                      -- MCP | REST | INTERNAL
  action_type TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  amount_paise INTEGER,
  decision TEXT NOT NULL,                      -- ALLOW | HUMAN_APPROVAL | REAUTHORIZE | BLOCK
  reason TEXT NOT NULL,
  violations TEXT NOT NULL,                    -- JSON: RuleViolation[]
  drift TEXT,                                  -- JSON: DriftBreakdown (nullable)
  receipt TEXT NOT NULL,                      -- JSON: DecisionReceipt (full explainability snapshot)
  idempotency_key TEXT NOT NULL,
  approval_id TEXT,
  approved_at TEXT,
  consumed_at TEXT,                            -- set when execution effects were applied exactly once
  created_at TEXT NOT NULL
);
CREATE INDEX authorization_decisions_dedupe_idx
  ON authorization_decisions(agent_id, action_type, idempotency_key);
CREATE INDEX authorization_decisions_session_idx ON authorization_decisions(session_id);
CREATE INDEX authorization_decisions_created_idx ON authorization_decisions(created_at);
CREATE INDEX authorization_decisions_decision_idx ON authorization_decisions(decision);

CREATE TABLE human_approvals (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES authorization_decisions(id),
  approved_by TEXT NOT NULL,                   -- a user id; never an agent id
  outcome TEXT NOT NULL,                       -- approved | rejected
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX human_approvals_decision_idx ON human_approvals(decision_id);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  action TEXT,
  decision TEXT,
  reason TEXT,
  input_hash TEXT NOT NULL,
  policy_version INTEGER,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  payload TEXT                                  -- JSON (nullable)
);
CREATE UNIQUE INDEX audit_events_sequence_idx ON audit_events(sequence);
CREATE INDEX audit_events_type_idx ON audit_events(event_type);

CREATE TABLE fuzz_runs (
  id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL,
  cases INTEGER NOT NULL,
  max_sequence_length INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  stats TEXT                                    -- JSON: FuzzRunStats (nullable until finished)
);

CREATE TABLE fuzz_cases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES fuzz_runs(id),
  case_index INTEGER NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  bypass INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fuzz_cases_run_idx ON fuzz_cases(run_id, case_index);

CREATE TABLE growth_opportunities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                           -- upsell | cross_sell | bundle
  product_id TEXT NOT NULL REFERENCES products(id),
  anchor_product_id TEXT NOT NULL REFERENCES products(id),
  amount_paise INTEGER NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  stats TEXT,                                   -- JSON: GrowthStats (nullable)
  status TEXT NOT NULL,                         -- PROPOSED | ALLOWED | BLOCKED | CONVERTED
  decision TEXT,
  decision_id TEXT,
  proposed_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX growth_opportunities_status_idx ON growth_opportunities(status);

CREATE TABLE protocol_requests (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  protocol TEXT NOT NULL,                       -- MCP | REST | INTERNAL
  tool TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,                         -- ACCEPTED | DENIED | ERROR
  decision TEXT,
  decision_id TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX protocol_requests_request_id_idx ON protocol_requests(request_id);