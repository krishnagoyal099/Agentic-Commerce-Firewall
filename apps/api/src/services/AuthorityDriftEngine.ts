// apps/api/src/services/AuthorityDriftEngine.ts
import { and, eq, isNull } from 'drizzle-orm';
import {
  DRIFT_APPROVAL_DEFAULT,
  DRIFT_BLOCK_DEFAULT,
  DRIFT_CUSHION_RATIO,
  DRIFT_CATEGORY_AVG_SCALE,
  DRIFT_CATEGORY_MAX_SCALE,
  DRIFT_DEVIATION_NORMALIZER,
  DRIFT_WEIGHTS,
  clamp01,
  computeOverallDrift,
  formatINR,
  nearestAllowedDistance,
  round3,
  type DriftBreakdown,
  type ProtocolName,
} from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { DriftSessionRow, MandateRow, PolicyRow } from '../db/schema';
import * as schema from '../db/schema';
import type { Clock } from '../utils/clock';
import { newId } from '../utils/ids';
import type { ResolvedCartItem } from './CatalogService';

export interface AttemptRecord {
  scopeExpanding: boolean;
  attemptedDiscountPaise: number;
}

/**
 * Authority drift (§23, §40) — a continuous 0.00–1.00 score per
 * (agent, mandate) session. Deterministic arithmetic only; no LLM.
 *
 * Session state:
 *   - EXECUTED effects (monetary, category): recorded when an allowed action
 *     actually applies items — accumulates across carts, so multi-cart abuse
 *     still drifts (this is precisely what authority drift exists to catch).
 *   - ATTEMPTED effects (discount, action-count): recorded during evaluation,
 *     including blocked attempts — drift is a leading behavioral indicator.
 *   - TEMPORAL: fraction of mandate lifetime consumed, from the Clock.
 */
export class AuthorityDriftEngine {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
  ) {}

  getSession(agentId: string, mandateId: string, protocol: ProtocolName): DriftSessionRow {
    const existing = this.db
      .select()
      .from(schema.driftSessions)
      .where(
        and(
          eq(schema.driftSessions.agentId, agentId),
          eq(schema.driftSessions.mandateId, mandateId),
          isNull(schema.driftSessions.closedAt),
        ),
      )
      .get();
    if (existing) return existing;
    const nowIso = this.clock.now().toISOString();
    const row: DriftSessionRow = {
      id: newId('sess'),
      agentId,
      mandateId,
      protocol,
      actionCount: 0,
      scopeExpandingActions: 0,
      nonCoreSpendPaise: 0,
      sessionDiscountPaise: 0,
      sessionItemDistances: [],
      currentBreakdown: null,
      startedAt: nowIso,
      updatedAt: nowIso,
      closedAt: null,
    };
    this.db.insert(schema.driftSessions).values(row).run();
    return row;
  }

  getSessionById(sessionId: string): DriftSessionRow | null {
    return this.db.select().from(schema.driftSessions).where(eq(schema.driftSessions.id, sessionId)).get() ?? null;
  }

  recordAttempt(sessionId: string, record: AttemptRecord): void {
    const session = this.getSessionById(sessionId);
    if (!session) return;
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.driftSessions)
      .set({
        actionCount: session.actionCount + 1,
        scopeExpandingActions: session.scopeExpandingActions + (record.scopeExpanding ? 1 : 0),
        sessionDiscountPaise: session.sessionDiscountPaise + Math.max(0, Math.trunc(record.attemptedDiscountPaise)),
        updatedAt: nowIso,
      })
      .where(eq(schema.driftSessions.id, sessionId))
      .run();
  }

  recordExecutedItems(sessionId: string, items: readonly ResolvedCartItem[], mandate: MandateRow): void {
    const session = this.getSessionById(sessionId);
    if (!session) return;
    const allowed = mandate.allowedCategories as string[];
    let nonCore = 0;
    const distances: number[] = [];
    for (const item of items) {
      distances.push(nearestAllowedDistance(item.category, allowed));
      if (!allowed.includes(item.category)) {
        nonCore += item.unitPricePaise * item.quantity;
      }
    }
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.driftSessions)
      .set({
        nonCoreSpendPaise: session.nonCoreSpendPaise + nonCore,
        sessionItemDistances: [...(session.sessionItemDistances ?? []), ...distances],
        updatedAt: nowIso,
      })
      .where(eq(schema.driftSessions.id, sessionId))
      .run();
  }

  computeBreakdown(
    session: DriftSessionRow,
    mandate: MandateRow,
    policy: PolicyRow,
    now: Date,
  ): DriftBreakdown {
    const cushionPaise = Math.max(1, Math.round(mandate.maxAmountPaise * DRIFT_CUSHION_RATIO));
    const nonCorePaise = session.nonCoreSpendPaise;
    const monetary = round3(clamp01(nonCorePaise / cushionPaise));

    const distances = session.sessionItemDistances ?? [];
    let category = 0;
    if (distances.length > 0) {
      const avg = distances.reduce((s, d) => s + d, 0) / distances.length;
      const max = Math.max(...distances);
      category = round3(clamp01(avg * DRIFT_CATEGORY_AVG_SCALE + max * DRIFT_CATEGORY_MAX_SCALE));
    }

    const maxDiscountPaise = Math.max(1, policy.maxDiscountPaise);
    const discount = round3(clamp01(session.sessionDiscountPaise / maxDiscountPaise));

    const issuedMs = Date.parse(mandate.issuedAt);
    const expiresMs = Date.parse(mandate.expiresAt);
    const durationMs = expiresMs - issuedMs;
    const temporal =
      durationMs > 0 ? round3(clamp01((now.getTime() - issuedMs) / durationMs)) : 1;

    const action = round3(clamp01(session.scopeExpandingActions / DRIFT_DEVIATION_NORMALIZER));

    const partial = { monetary, category, discount, temporal, action };
    const overall = computeOverallDrift(partial);

    return {
      ...partial,
      overall,
      explanation: {
        monetary: `Non-core spend ${formatINR(nonCorePaise)} of ${formatINR(cushionPaise)} discretionary cushion (${Math.round(DRIFT_CUSHION_RATIO * 100)}% of mandate cap).`,
        category:
          distances.length === 0
            ? 'No off-intent items in session yet.'
            : `Average category distance ${partial.category > 0 ? distances.reduce((s, d) => s + d, 0) / distances.length : 0} and maximum ${Math.max(...distances)} from allowed categories.`,
        discount: `Session attempted discount ${formatINR(session.sessionDiscountPaise)} against policy limit ${formatINR(policy.maxDiscountPaise)}.`,
        temporal: `${Math.round(temporal * 100)}% of mandate lifetime consumed.`,
        action: `${session.scopeExpandingActions} of ${DRIFT_DEVIATION_NORMALIZER} scope-expanding actions in session.`,
        overall: `Weighted sum: 0.30×${monetary} + 0.25×${category} + 0.20×${discount} + 0.10×${temporal} + 0.15×${action} = ${overall}.`,
      },
    };
  }

  /** Thresholds: strictly ABOVE require_approval_above_drift → HUMAN_APPROVAL; above block_above_drift → BLOCK. */
  approvalThreshold(policy: PolicyRow): number {
    return policy.requireApprovalAboveDrift > 0 ? policy.requireApprovalAboveDrift : DRIFT_APPROVAL_DEFAULT;
  }

  blockThreshold(policy: PolicyRow): number {
    return policy.blockAboveDrift > 0 ? policy.blockAboveDrift : DRIFT_BLOCK_DEFAULT;
  }
}

export { DRIFT_WEIGHTS };