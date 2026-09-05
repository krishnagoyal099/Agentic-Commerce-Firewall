// tests/fuzzing/fuzzer.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../apps/api/src/db/schema';
import { createTestApp, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

describe('deterministic fuzzer (§41–§43, §68, §69 fuzzing list)', () => {
  it('runs every case through the real firewall with consistent statistics', async () => {
    const out = await t.ctx.fuzzer.run({ cases: 200, seed: 1337, maxSequenceLength: 3 });
    const s = out.run.stats;
    expect(s.totalCases).toBe(200);
    expect(s.allowed + s.blocked + s.reauthorized + s.humanApproval + s.failures).toBe(s.totalCases);
    expect(s.failures).toBe(0);
    expect(s.bypasses).toBe(0);
    expect(out.bypasses).toHaveLength(0);

    // The run and its real statistics persist for dashboard metrics.
    const row = t.ctx.db.select().from(schema.fuzzRuns).where(eq(schema.fuzzRuns.id, out.run.id)).get();
    expect(row?.stats?.totalCases).toBe(200);
    expect(t.ctx.audit.list({ limit: 500 }).some((e) => e.eventType === 'FUZZ_RUN')).toBe(true);
  });

  it('identical seeds produce identical statistics (seed determinism)', async () => {
    const a = await t.ctx.fuzzer.run({ cases: 60, seed: 99, maxSequenceLength: 3 });
    const t2 = createTestApp();
    let b;
    try {
      b = await t2.ctx.fuzzer.run({ cases: 60, seed: 99, maxSequenceLength: 3 });
    } finally {
      t2.close();
    }
    expect(JSON.stringify(b.run.stats)).toBe(JSON.stringify(a.run.stats));
  });

  it('different seeds remain internally consistent', async () => {
    const a = await t.ctx.fuzzer.run({ cases: 60, seed: 1, maxSequenceLength: 3 });
    const b = await t.ctx.fuzzer.run({ cases: 60, seed: 2, maxSequenceLength: 3 });
    for (const out of [a, b]) {
      const s = out.run.stats;
      expect(s.totalCases).toBe(60);
      expect(s.allowed + s.blocked + s.reauthorized + s.humanApproval + s.failures).toBe(60);
      expect(s.bypasses).toBe(0);
    }
  });

  it('persists sample case rows for inspection', async () => {
    const out = await t.ctx.fuzzer.run({ cases: 60, seed: 7, maxSequenceLength: 3 });
    const rows = t.ctx.db
      .select()
      .from(schema.fuzzCases)
      .where(eq(schema.fuzzCases.runId, out.run.id))
      .all();
    // Every 25th case is sampled: indices 0, 25, 50 → ≥ 3 rows.
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});