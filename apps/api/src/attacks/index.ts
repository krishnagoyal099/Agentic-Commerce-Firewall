// apps/api/src/attacks/index.ts  (FULL FINAL — safe fail-closed lookup)
import { type AttackName, type AttackReport } from '@acsf/shared';
import type { ServiceContext } from '../context';
import type { ProtocolGateway } from '../protocol/ProtocolGateway';
import type { MCPCommerceAdapter } from '../protocol/mcp/MCPCommerceAdapter';
import { runners } from './runners';
import type { AttackDeps, AttackRunner } from './types';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';

/**
 * Attack Lab service (§38). Runs real attacks against the live application
 * state through the normal gateway → AuthorizationEngine path, then appends
 * an ATTACK_EXECUTED audit event. Attacks mutate live state (real decisions,
 * carts, payments) — RESET DEMO restores everything.
 */
export class AttackService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly gateway: ProtocolGateway,
    private readonly adapter: MCPCommerceAdapter,
  ) {}

  async run(name: AttackName): Promise<AttackReport> {
    const runner = (runners as Record<string, AttackRunner | undefined>)[name];
    if (runner === undefined) {
      throw new DomainError('UNKNOWN_ATTACK', `Attack "${name}" has no implementation.`);
    }
    const deps: AttackDeps = { ctx: this.ctx, gateway: this.gateway, adapter: this.adapter };
    const report = await runner(deps);
    const event = this.ctx.audit.append({
      actor: 'attack-lab',
      eventType: 'ATTACK_EXECUTED',
      action: `attack.${name}`,
      decision: report.decision,
      reason: `${report.title}: ${report.decision}${report.violatedRule !== null ? ` — ${report.violatedRule}` : ''}`,
      inputHash: sha256JSON({ attack: name }),
      payload: {
        attack: name,
        decision: report.decision,
        decisionId: report.decisionId,
        paymentId: report.paymentId,
        drift: report.drift,
        steps: report.steps.length,
      },
    });
    return { ...report, auditEventId: event.eventId };
  }
}