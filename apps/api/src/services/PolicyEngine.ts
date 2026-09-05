// apps/api/src/services/PolicyEngine.ts
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { GRANTABLE_CAPABILITIES, rupeesToPaise } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { PolicyRow } from '../db/schema';
import * as schema from '../db/schema';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import type { AuditService } from './AuditService';
import type { Clock } from '../utils/clock';

export const PolicyPatchSchema = z
  .object({
    maxOrderAmountRupees: z.number().int().min(1).max(10_000_000),
    maxDiscountRupees: z.number().int().min(0).max(100_000),
    maxRefundRupees: z.number().int().min(0).max(1_000_000),
    dailyBudgetRupees: z.number().int().min(1).max(100_000_000),
    allowUpsells: z.boolean(),
    allowCartModification: z.boolean(),
    requireApprovalAboveDrift: z.number().gt(0).lt(1),
    blockAboveDrift: z.number().gt(0).lt(1),
    authorizationTtlMinutes: z.number().int().min(1).max(1440),
    minimumMarginPercent: z.number().int().min(0).max(100),
    allowedCapabilities: z.array(z.enum(GRANTABLE_CAPABILITIES)).min(1),
  })
  .partial()
  .strict();

export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;

/**
 * Merchant policy (§14, §62). Policies are immutable versioned rows: an update
 * validates with Zod, creates version N+1, audits the change, and NEVER
 * rewrites history — every persisted decision keeps the version it used.
 * Agents can never modify policy: updatedBy is rejected if it names an agent.
 */
export class PolicyEngine {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  getActivePolicy(merchantId: string): PolicyRow | null {
    return (
      this.db
        .select()
        .from(schema.policies)
        .where(eq(schema.policies.merchantId, merchantId))
        .orderBy(desc(schema.policies.version))
        .limit(1)
        .get() ?? null
    );
  }

  getPolicyAtVersion(merchantId: string, version: number): PolicyRow | null {
    return (
      this.db
        .select()
        .from(schema.policies)
        .where(eq(schema.policies.merchantId, merchantId))
        .orderBy(desc(schema.policies.version))
        .all()
        .find((row) => row.version === version) ?? null
    );
  }

  updatePolicy(merchantId: string, rawPatch: unknown, updatedBy: string): PolicyRow {
    const parsed = PolicyPatchSchema.safeParse(rawPatch);
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_POLICY_PATCH',
        `Policy patch failed validation: ${parsed.error.issues[0]?.path.join('.') ?? '(root)'} ${parsed.error.issues[0]?.message ?? ''}`,
      );
    }
    const patch = parsed.data;

    const agentRow = this.db.select().from(schema.agents).where(eq(schema.agents.id, updatedBy)).get();
    if (agentRow) {
      throw new DomainError(
        'POLICY_MODIFICATION_BY_AGENT',
        `Agents may not modify merchant policy. "${updatedBy}" is an agent.`,
      );
    }

    const current = this.getActivePolicy(merchantId);
    if (!current) {
      throw new DomainError('POLICY_MISSING', `No policy exists for merchant ${merchantId}.`);
    }

    const next: PolicyRow = {
      ...current,
      id: `policy-${merchantId}-v${current.version + 1}`,
      version: current.version + 1,
      maxOrderAmountPaise:
        patch.maxOrderAmountRupees !== undefined ? rupeesToPaise(patch.maxOrderAmountRupees) : current.maxOrderAmountPaise,
      maxDiscountPaise:
        patch.maxDiscountRupees !== undefined ? rupeesToPaise(patch.maxDiscountRupees) : current.maxDiscountPaise,
      maxRefundPaise:
        patch.maxRefundRupees !== undefined ? rupeesToPaise(patch.maxRefundRupees) : current.maxRefundPaise,
      dailyBudgetPaise:
        patch.dailyBudgetRupees !== undefined ? rupeesToPaise(patch.dailyBudgetRupees) : current.dailyBudgetPaise,
      allowUpsells: patch.allowUpsells ?? current.allowUpsells,
      allowCartModification: patch.allowCartModification ?? current.allowCartModification,
      requireApprovalAboveDrift: patch.requireApprovalAboveDrift ?? current.requireApprovalAboveDrift,
      blockAboveDrift: patch.blockAboveDrift ?? current.blockAboveDrift,
      authorizationTtlMinutes: patch.authorizationTtlMinutes ?? current.authorizationTtlMinutes,
      minimumMarginPercent: patch.minimumMarginPercent ?? current.minimumMarginPercent,
      allowedCapabilities: patch.allowedCapabilities ? [...patch.allowedCapabilities] : current.allowedCapabilities,
      createdBy: updatedBy,
      createdAt: this.clock.now().toISOString(),
    };

    if (next.blockAboveDrift < next.requireApprovalAboveDrift) {
      throw new DomainError(
        'INVALID_POLICY_PATCH',
        `blockAboveDrift (${next.blockAboveDrift}) must be >= requireApprovalAboveDrift (${next.requireApprovalAboveDrift}).`,
      );
    }

    this.db.insert(schema.policies).values(next).run();
    this.audit.append({
      actor: updatedBy,
      eventType: 'POLICY_CHANGE',
      action: 'policy.updated',
      reason: `Merchant policy updated to v${next.version}.`,
      inputHash: sha256JSON(patch),
      policyVersion: next.version,
      payload: {
        merchantId,
        fromVersion: current.version,
        toVersion: next.version,
        changes: patch,
      },
    });
    return next;
  }
}