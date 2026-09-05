// apps/api/src/services/AuditService.ts
import { asc, desc, eq } from 'drizzle-orm';
import type { AuditChainStatus, AuditEventDTO, AuditEventType, Decision } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { AuditEventRow } from '../db/schema';
import * as schema from '../db/schema';
import type { Clock } from '../utils/clock';
import { newId } from '../utils/ids';
import { sha256JSON } from '../utils/hash';

export interface AppendAuditInput {
  actor: string;
  eventType: AuditEventType;
  action?: string | null;
  decision?: Decision | null;
  reason?: string | null;
  inputHash: string;
  policyVersion?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface AuditListOptions {
  limit?: number;
  offset?: number;
  eventType?: AuditEventType;
}

function toDTO(row: AuditEventRow): AuditEventDTO {
  return {
    eventId: row.eventId,
    sequence: row.sequence,
    timestamp: row.timestamp,
    actor: row.actor,
    eventType: row.eventType,
    action: row.action ?? null,
    decision: row.decision ?? null,
    reason: row.reason ?? null,
    inputHash: row.inputHash,
    policyVersion: row.policyVersion ?? null,
    previousEventHash: row.previousEventHash ?? null,
    eventHash: row.eventHash,
    payload: row.payload ?? null,
  };
}

/** The hash-chain fields — the exact bytes covered by eventHash. */
function chainHashPayload(row: {
  previousEventHash: string | null;
  sequence: number;
  timestamp: string;
  actor: string;
  eventType: AuditEventType;
  action: string | null;
  decision: Decision | null;
  reason: string | null;
  inputHash: string;
  policyVersion: number | null;
  payload: Record<string, unknown> | null;
}): string {
  return sha256JSON({
    previousEventHash: row.previousEventHash,
    sequence: row.sequence,
    timestamp: row.timestamp,
    actor: row.actor,
    eventType: row.eventType,
    action: row.action,
    decision: row.decision,
    reason: row.reason,
    inputHash: row.inputHash,
    policyVersion: row.policyVersion,
    payload: row.payload,
  });
}

/**
 * Hash-chained audit trail (§44). Every event links to its predecessor via
 * SHA-256; verifyAuditChain() detects any tampering. Appends are transactional
 * and sequence-strict (better-sqlite3 is synchronous — no interleaving).
 */
export class AuditService {
  /** Invalidated by every append and keyed on the head anchor. */
  private cachedStatus: { key: string; status: AuditChainStatus } | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
  ) {}

  /** Re-seeds the anchor after a wipe; see resetTransactionalState. */
  resetChainAnchor(): void {
    this.db.delete(schema.auditChainHead).run();
    this.cachedStatus = null;
  }

  append(input: AppendAuditInput): AuditEventDTO {
    const timestamp = this.clock.now().toISOString();
    const created = this.db.transaction((tx) => {
      const last = tx
        .select({ sequence: schema.auditEvents.sequence, eventHash: schema.auditEvents.eventHash })
        .from(schema.auditEvents)
        .orderBy(desc(schema.auditEvents.sequence))
        .limit(1)
        .get();
      const sequence = (last?.sequence ?? 0) + 1;
      const previousEventHash = last?.eventHash ?? null;
      const eventId = newId('evt');
      const action = input.action ?? null;
      const decision = input.decision ?? null;
      const reason = input.reason ?? null;
      const policyVersion = input.policyVersion ?? null;
      const payload = input.payload ?? null;
      const eventHash = chainHashPayload({
        previousEventHash,
        sequence,
        timestamp,
        actor: input.actor,
        eventType: input.eventType,
        action,
        decision,
        reason,
        inputHash: input.inputHash,
        policyVersion,
        payload,
      });
      tx.insert(schema.auditEvents)
        .values({
          eventId,
          sequence,
          timestamp,
          actor: input.actor,
          eventType: input.eventType,
          action,
          decision,
          reason,
          inputHash: input.inputHash,
          policyVersion,
          previousEventHash,
          eventHash,
          payload,
        })
        .run();
      // The anchor moves with the chain, in the SAME transaction. Without it
      // deleting the tail of audit_events left a chain that still verified.
      tx.insert(schema.auditChainHead)
        .values({ id: 'head', sequence, eventHash, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: schema.auditChainHead.id,
          set: { sequence, eventHash, updatedAt: timestamp },
        })
        .run();
      return { eventId, sequence };
    });
    this.cachedStatus = null;
    const row = this.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventId, created.eventId))
      .get();
    if (!row) {
      throw new Error('Audit append failed: event not readable after insert.');
    }
    return toDTO(row);
  }

  /**
   * Re-hashes the whole chain, so it is memoised against the current head.
   * The dashboard polls /api/metrics every 5s and /api/audit/verify every 8s,
   * and better-sqlite3 is synchronous — recomputing SHA-256 over a
   * monotonically growing table on every poll blocked the event loop for
   * longer and longer as a demo went on.
   */
  verifyChain(): AuditChainStatus {
    const anchor = this.db
      .select()
      .from(schema.auditChainHead)
      .where(eq(schema.auditChainHead.id, 'head'))
      .get();
    const cacheKey = `${anchor?.sequence ?? 0}:${anchor?.eventHash ?? 'none'}`;
    if (this.cachedStatus !== null && this.cachedStatus.key === cacheKey) {
      return this.cachedStatus.status;
    }
    const status = this.computeChainStatus(anchor ?? null);
    this.cachedStatus = { key: cacheKey, status };
    return status;
  }

  private computeChainStatus(
    anchor: { sequence: number; eventHash: string } | null,
  ): AuditChainStatus {
    const rows = this.db.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.sequence)).all();
    let previousEventHash: string | null = null;
    let expectedSequence = 1;
    for (const row of rows) {
      if (row.sequence !== expectedSequence) {
        return {
          valid: false,
          eventCount: rows.length,
          firstInvalidSequence: row.sequence,
          message: `Audit chain broken: expected sequence ${expectedSequence}, found ${row.sequence}.`,
        };
      }
      if ((row.previousEventHash ?? null) !== previousEventHash) {
        return {
          valid: false,
          eventCount: rows.length,
          firstInvalidSequence: row.sequence,
          message: `Audit chain broken at event ${row.sequence}: previous-event link does not match.`,
        };
      }
      const recomputed = chainHashPayload({
        previousEventHash: row.previousEventHash ?? null,
        sequence: row.sequence,
        timestamp: row.timestamp,
        actor: row.actor,
        eventType: row.eventType,
        action: row.action ?? null,
        decision: row.decision ?? null,
        reason: row.reason ?? null,
        inputHash: row.inputHash,
        policyVersion: row.policyVersion ?? null,
        payload: row.payload ?? null,
      });
      if (recomputed !== row.eventHash) {
        return {
          valid: false,
          eventCount: rows.length,
          firstInvalidSequence: row.sequence,
          message: `Audit chain tampering detected at event ${row.sequence}: stored hash does not match recomputed hash.`,
        };
      }
      previousEventHash = row.eventHash;
      expectedSequence += 1;
    }
    // Links and hashes can all be intact and the chain still be a lie: dropping
    // the last K events leaves 1..N-K perfectly self-consistent. The anchor is
    // the only thing that knows where the chain was supposed to end.
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    if (anchor !== null) {
      if (last === null) {
        return {
          valid: false,
          eventCount: 0,
          firstInvalidSequence: anchor.sequence,
          message: `Audit chain truncated: the recorded head is event ${anchor.sequence}, but no events remain.`,
        };
      }
      if (last.sequence !== anchor.sequence || last.eventHash !== anchor.eventHash) {
        return {
          valid: false,
          eventCount: rows.length,
          firstInvalidSequence: anchor.sequence,
          message:
            last.sequence < anchor.sequence
              ? `Audit chain truncated: ${anchor.sequence - last.sequence} event(s) removed from the end (head recorded at ${anchor.sequence}, last present is ${last.sequence}).`
              : `Audit chain head mismatch at event ${last.sequence}: the recorded head does not match the last stored event.`,
        };
      }
    }
    return {
      valid: true,
      eventCount: rows.length,
      firstInvalidSequence: null,
      message:
        rows.length === 0
          ? 'No audit events recorded yet.'
          : `Chain intact across ${rows.length} events, head anchored at ${rows.length}.`,
    };
  }

  list(options: AuditListOptions = {}): AuditEventDTO[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = this.db
      .select()
      .from(schema.auditEvents)
      .where(options.eventType ? eq(schema.auditEvents.eventType, options.eventType) : undefined)
      .orderBy(desc(schema.auditEvents.sequence))
      .limit(limit)
      .offset(offset)
      .all();
    return rows.map(toDTO);
  }

  count(): number {
    return this.db.select({ eventId: schema.auditEvents.eventId }).from(schema.auditEvents).all().length;
  }
}