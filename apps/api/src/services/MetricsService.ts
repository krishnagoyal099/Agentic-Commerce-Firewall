// apps/api/src/services/MetricsService.ts
import { and, eq } from 'drizzle-orm';
import { round3, type MetricsSnapshot } from '@acsf/shared';
import type { ServiceContext } from '../context';
import * as schema from '../db/schema';

/**
 * Dashboard metrics (§48, §79). Every value is computed from persisted
 * application state — no hardcoding, no fabrication.
 */
export class MetricsService {
  constructor(private readonly ctx: ServiceContext) {}

  snapshot(): MetricsSnapshot {
    const db = this.ctx.db;

    const decisionRows = db
      .select({
        decision: schema.authorizationDecisions.decision,
        drift: schema.authorizationDecisions.drift,
        consumedAt: schema.authorizationDecisions.consumedAt,
      })
      .from(schema.authorizationDecisions)
      .all();
    const decisionCounts = { ALLOW: 0, HUMAN_APPROVAL: 0, REAUTHORIZE: 0, BLOCK: 0 };
    let autonomousActions = 0;
    const driftValues: number[] = [];
    for (const row of decisionRows) {
      decisionCounts[row.decision] += 1;
      if (row.consumedAt !== null) autonomousActions += 1;
      if (row.drift !== null && typeof row.drift.overall === 'number') driftValues.push(row.drift.overall);
    }

    const humanApprovals = db
      .select({ id: schema.humanApprovals.id })
      .from(schema.humanApprovals)
      .where(eq(schema.humanApprovals.outcome, 'approved'))
      .all().length;

    // Only a prevented CHARGE counts. The duplicate flag is also set on
    // idempotent provider-webhook replays, which prevented nothing — counting
    // those inflated the headline "duplicate payments prevented" every time
    // someone re-sent an event from the Payments tab.
    const duplicatePaymentsPrevented = db
      .select({ id: schema.paymentEvents.id })
      .from(schema.paymentEvents)
      .where(
        and(eq(schema.paymentEvents.duplicate, true), eq(schema.paymentEvents.event, 'create.replay_ignored')),
      )
      .all().length;

    const growthOpportunities = db.select({ id: schema.growthOpportunities.id }).from(schema.growthOpportunities).all().length;

    const protocolTransactions = db
      .select({ id: schema.protocolRequests.id })
      .from(schema.protocolRequests)
      .where(eq(schema.protocolRequests.status, 'ACCEPTED'))
      .all().length;

    // `cases` is the REQUESTED count, written before the run starts and never
    // corrected — a run that threw part-way still claimed its full N. stats is
    // written on completion and carries what actually executed.
    const fuzzRunRows = db
      .select({ cases: schema.fuzzRuns.cases, stats: schema.fuzzRuns.stats })
      .from(schema.fuzzRuns)
      .all();
    const fuzzCasesTested = fuzzRunRows.reduce(
      (sum, row) => sum + (typeof row.stats?.totalCases === 'number' ? row.stats.totalCases : 0),
      0,
    );

    const policyBypasses = db
      .select({ id: schema.fuzzCases.id })
      .from(schema.fuzzCases)
      .where(eq(schema.fuzzCases.bypass, true))
      .all().length;

    const policy = this.ctx.policies.getActivePolicy(this.ctx.merchantId);
    const averageAuthorityDrift =
      driftValues.length > 0
        ? round3(driftValues.reduce((s, v) => s + v, 0) / driftValues.length)
        : 0;

    return {
      revenueGeneratedPaise: this.ctx.payments.getRevenueCapturedPaise(),
      autonomousActions,
      blockedActions: decisionCounts.BLOCK,
      humanApprovals,
      reauthorizations: decisionCounts.REAUTHORIZE,
      duplicatePaymentsPrevented,
      currentDailyBudgetPaise: this.ctx.payments.getCommittedSpendToday(),
      dailyBudgetLimitPaise: policy?.dailyBudgetPaise ?? 0,
      averageAuthorityDrift,
      fuzzCasesTested,
      policyBypasses,
      growthOpportunities,
      protocolTransactions,
      decisionCounts,
      auditChain: this.ctx.audit.verifyChain(),
    };
  }
}
