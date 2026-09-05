-- 0001_audit_chain_head_and_indexes.sql
--
-- 1. audit_chain_head — makes truncation of the audit chain detectable.
--
--    verifyChain() walks audit_events checking contiguous sequence, matching
--    links and recomputed hashes. Deleting the LAST K events breaks none of
--    those: sequences 1..N-K stay contiguous, every link still matches, and
--    verification reported "valid". The most recent events are exactly the
--    incriminating ones (BLOCKED_ACTION is appended last), so the cheapest
--    possible tamper was also the invisible one.
--
--    A single anchor row, written inside the same transaction as every append,
--    records where the chain is supposed to end. Verification now compares the
--    last row against it.
CREATE TABLE audit_chain_head (
  id TEXT PRIMARY KEY,                          -- always 'head'
  sequence INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed the anchor from whatever the chain currently holds, so an existing
-- database is not reported as tampered the moment this migration lands.
INSERT INTO audit_chain_head (id, sequence, event_hash, updated_at)
SELECT 'head', sequence, event_hash, timestamp
FROM audit_events
ORDER BY sequence DESC
LIMIT 1;

-- 2. Indexes on two hot paths that were doing full table scans.
--    payments.created_at is scanned by getCommittedSpendToday() on EVERY
--    payment authorization and again at execution; orders.status is scanned by
--    GrowthAnalytics, which the dashboard polls every 10 seconds.
CREATE INDEX IF NOT EXISTS payments_created_at_idx ON payments(created_at);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

-- 3. One review per decision. recordHumanApproval now refuses a second review
--    in code; this makes it true at the storage layer as well, so a
--    reject-then-approve cannot be smuggled in by any other path.
CREATE UNIQUE INDEX IF NOT EXISTS human_approvals_decision_idx ON human_approvals(decision_id);

-- 4. cart_items.margin_percent — freeze the margin with the line.
--
--    Cart lines already froze unit_price_paise, but GrowthAnalytics read
--    margin_percent from the LIVE products row. A merchant editing a margin in
--    the Merchant tab therefore retroactively rewrote the margin reported for
--    every historical co-purchase, and that mixed figure was then persisted
--    into growth_opportunities.stats and quoted in the audit reason.
--
--    Existing rows are backfilled from the current catalog — the best available
--    approximation for lines written before the column existed.
ALTER TABLE cart_items ADD COLUMN margin_percent INTEGER NOT NULL DEFAULT 0;

UPDATE cart_items
SET margin_percent = COALESCE(
  (SELECT p.margin_percent FROM products p WHERE p.id = cart_items.product_id),
  0
);
