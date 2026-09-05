// apps/api/src/services/MandateService.ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CATEGORIES, type Category, type MandateStatus } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { DriftSessionRow, MandateRow } from '../db/schema';
import * as schema from '../db/schema';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import type { AuditService } from './AuditService';
import type { Clock } from '../utils/clock';
import { rupeesToPaise } from '@acsf/shared';

export const MandateCreateSchema = z
  .object({
    userId: z.string().min(1).max(64),
    intent: z.string().trim().min(5).max(500),
    maxAmountRupees: z.number().int().min(1).max(10_000_000),
    allowedCategories: z.array(z.enum(CATEGORIES)).min(1),
    allowUpsell: z.boolean().default(true),
    ttlHours: z.number().int().min(1).max(2160).default(24),
  })
  .strict();

export type MandateCreateInput = z.input<typeof MandateCreateSchema>;

export interface MandateView {
  row: MandateRow;
  /** Status including lazy time-based expiry (row status may still say active). */
  effectiveStatus: MandateStatus;
}

/**
 * User mandates (§15, §63) — the explicit authority boundary. Mandates are
 * immutable, versioned rows: reauthorization creates v+1 and supersedes v.
 * Historical decisions stay tied to the mandate version used at the time.
 */
export class MandateService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  effectiveStatus(row: MandateRow, nowIso: string): MandateStatus {
    if (row.status === 'superseded') return 'superseded';
    if (row.expiresAt <= nowIso) return 'expired';
    return row.status;
  }

  getMandate(mandateId: string): MandateView | null {
    const row = this.db.select().from(schema.mandates).where(eq(schema.mandates.id, mandateId)).get();
    if (!row) return null;
    return { row, effectiveStatus: this.effectiveStatus(row, this.clock.now().toISOString()) };
  }

  getActiveMandateForUser(userId: string): MandateView | null {
    const rows = this.db.select().from(schema.mandates).where(eq(schema.mandates.userId, userId)).all();
    const nowIso = this.clock.now().toISOString();
    const candidates = rows
      .map((row) => ({ row, effectiveStatus: this.effectiveStatus(row, nowIso) }))
      .filter((view) => view.effectiveStatus === 'active')
      .sort((a, b) => (a.row.issuedAt < b.row.issuedAt ? 1 : -1));
    return candidates[0] ?? null;
  }

  /**
   * Mandates are the USER's authority object. An agent minting its own would
   * make every mandate limit self-service — and because drift sessions are
   * keyed on (agent, mandate), a fresh mandate also resets the agent's drift
   * score. PolicyEngine and CatalogAdminService already refuse an agent actor;
   * this closes the third door.
   *
   * NOTE: like those two, this can only reject an actor that names a row in
   * `agents`. It is not authentication — see the README's scope note.
   */
  private assertNotAgent(actor: string): void {
    const agentRow = this.db.select().from(schema.agents).where(eq(schema.agents.id, actor)).get();
    if (agentRow) {
      throw new DomainError(
        'MANDATE_MODIFICATION_BY_AGENT',
        `Agents may not issue mandates. "${actor}" is an agent.`,
      );
    }
  }

  createMandate(rawInput: MandateCreateInput, createdBy: string): MandateView {
    this.assertNotAgent(createdBy);
    const parsed = MandateCreateSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError('INVALID_MANDATE', `Mandate failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const input = parsed.data;
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000).toISOString();
    const mandateId = newId('mand');
    const row: MandateRow = {
      id: mandateId,
      userId: input.userId,
      intent: input.intent,
      maxAmountPaise: rupeesToPaise(input.maxAmountRupees),
      allowedCategories: [...input.allowedCategories],
      allowUpsell: input.allowUpsell,
      version: 1,
      status: 'active',
      issuedAt: nowIso,
      expiresAt,
      supersedesId: null,
      createdBy,
      createdAt: nowIso,
    };
    this.db.insert(schema.mandates).values(row).run();
    this.audit.append({
      actor: createdBy,
      eventType: 'USER_INTENT',
      action: 'mandate.created',
      reason: `User mandate issued: "${input.intent}"`,
      inputHash: sha256JSON(input),
      payload: {
        mandateId,
        version: 1,
        maxAmountPaise: row.maxAmountPaise,
        allowedCategories: row.allowedCategories,
        allowUpsell: row.allowUpsell,
        expiresAt,
      },
    });
    return { row, effectiveStatus: 'active' };
  }

  /**
   * Reauthorization (§61): the user issues a NEW mandate version. Never an
   * automatic upgrade — the caller must have collected fresh user intent.
   * Open drift sessions for the old mandate are closed (drift does not carry
   * across reauthorized authority).
   */
  supersedeMandate(oldMandateId: string, rawInput: MandateCreateInput, createdBy: string): MandateView {
    const old = this.getMandate(oldMandateId);
    if (!old) {
      throw new DomainError('MANDATE_NOT_FOUND', `Mandate ${oldMandateId} does not exist.`);
    }
    const created = this.createMandate(rawInput, createdBy);
    this.db
      .update(schema.mandates)
      .set({ status: 'superseded' })
      .where(eq(schema.mandates.id, oldMandateId))
      .run();
    this.db
      .update(schema.mandates)
      .set({ supersedesId: oldMandateId, version: old.row.version + 1 })
      .where(eq(schema.mandates.id, created.row.id))
      .run();
    const nowIso = this.clock.now().toISOString();
    this.db
      .update(schema.driftSessions)
      .set({ closedAt: nowIso, updatedAt: nowIso })
      .where(eq(schema.driftSessions.mandateId, oldMandateId))
      .run();
    const fresh = this.getMandate(created.row.id);
    if (!fresh) {
      throw new DomainError('MANDATE_NOT_FOUND', 'Created mandate missing after insert.');
    }
    this.audit.append({
      actor: createdBy,
      eventType: 'REAUTHORIZATION',
      action: 'mandate.superseded',
      reason: `Mandate v${old.row.version} superseded by v${fresh.row.version}; user reissued authority.`,
      inputHash: sha256JSON({ oldMandateId, input: rawInput }),
      payload: { fromMandateId: oldMandateId, toMandateId: fresh.row.id, fromVersion: old.row.version, toVersion: fresh.row.version },
    });
    return fresh;
  }
}

export type { DriftSessionRow };