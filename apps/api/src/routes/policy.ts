// apps/api/src/routes/policy.ts
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';
import * as schema from '../db/schema';
import { toPolicyDTO } from '../utils/dto';

const UpdatePolicySchema = z
  .object({
    updatedBy: z.string().min(1).max(64),
    patch: z.record(z.string(), z.unknown()),
  })
  .strict();

export function registerPolicyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/policy', async () => {
    const rows = ctx.db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.merchantId, ctx.merchantId))
      .orderBy(desc(schema.policies.version))
      .all();
    const activeVersion = rows[0]?.version ?? 0;
    return {
      active: rows.length > 0 ? toPolicyDTO(rows[0]!, true) : null,
      versions: rows.map((row) => toPolicyDTO(row, row.version === activeVersion)),
    };
  });

  // Policy updates validate with Zod, create a new version, audit the change,
  // and never rewrite history. Agents are rejected (PolicyEngine enforces).
  app.put('/api/policy', async (request) => {
    const body = parseOrThrow(UpdatePolicySchema, request.body);
    const updated = ctx.policies.updatePolicy(ctx.merchantId, body.patch, body.updatedBy);
    return { policy: toPolicyDTO(updated, true) };
  });
}