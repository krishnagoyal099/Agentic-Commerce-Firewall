// apps/api/src/routes/fuzzer.ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FuzzRunDTO, FuzzRunStats } from '@acsf/shared';
import type { AppContext } from '../appContext';
import * as schema from '../db/schema';
import { parseOrThrow } from '../schemas';
import { DomainError } from '../utils/errors';

const FuzzRunSchema = z
  .object({
    // Was 50_000. FuzzerService.run is a synchronous loop awaited inside the
    // request handler over a synchronous SQLite driver, so the single Node
    // process serves nothing else until it finishes — an unauthenticated route
    // that could freeze the whole API for minutes. The UI never asks for more
    // than a few thousand; run larger sweeps from the CLI (npm run fuzz).
    cases: z.number().int().min(1).max(5_000),
    seed: z.number().int().min(0).max(2_147_483_647),
    maxSequenceLength: z.number().int().min(1).max(12),
  })
  .strict();

const EMPTY_STATS: FuzzRunStats = {
  totalCases: 0,
  allowed: 0,
  blocked: 0,
  reauthorized: 0,
  humanApproval: 0,
  policyViolations: 0,
  bypasses: 0,
  failures: 0,
};

export function registerFuzzerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/fuzzer/run', async (request) => {
    const body = parseOrThrow(FuzzRunSchema, request.body);
    return ctx.fuzzer.run(body);
  });

  app.get('/api/fuzzer/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const run = ctx.db.select().from(schema.fuzzRuns).where(eq(schema.fuzzRuns.id, id)).get();
    if (run === undefined) {
      throw new DomainError('FUZZ_RUN_NOT_FOUND', `Fuzz run ${id} does not exist.`);
    }
    const cases = ctx.db
      .select()
      .from(schema.fuzzCases)
      .where(eq(schema.fuzzCases.runId, id))
      .orderBy(schema.fuzzCases.caseIndex)
      .all();
    // Runs complete synchronously within the POST; the fallbacks are defensive only.
    const dto: FuzzRunDTO = {
      id: run.id,
      seed: run.seed,
      cases: run.cases,
      maxSequenceLength: run.maxSequenceLength,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? new Date().toISOString(),
      durationMs: run.durationMs ?? 0,
      stats: run.stats ?? { ...EMPTY_STATS, totalCases: run.cases },
    };
    return {
      run: dto,
      cases: cases.map((c) => ({
        id: c.id,
        runId: c.runId,
        caseIndex: c.caseIndex,
        description: c.description,
        category: c.category,
        outcome: c.outcome,
        reason: c.reason,
        bypass: c.bypass,
      })),
    };
  });
}