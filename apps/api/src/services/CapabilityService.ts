// apps/api/src/services/CapabilityService.ts
import { eq } from 'drizzle-orm';
import {
  capabilityForAction,
  isGrantableCapability,
  isKnownCapability,
  isPrivilegedCapability,
  type ActionType,
  type RuleViolation,
  type GrantableCapability,
} from '@acsf/shared';
import { violation } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { AgentRow, PolicyRow } from '../db/schema';
import * as schema from '../db/schema';

export interface CapabilityCheckResult {
  agent: AgentRow | null;
  violations: RuleViolation[];
  /** Grantable capabilities actually held by the agent. */
  granted: GrantableCapability[];
  required: string;
}

/**
 * Capability security (§17, §36).
 * - Unknown capability tokens fail CLOSED (CAPABILITY_UNKNOWN → BLOCK).
 * - Privileged capabilities (refund, payout, settlement, policy, mandate) can
 *   never be required or requested by any agent (CAPABILITY_PRIVILEGED → BLOCK)
 *   — even if a tampered agents row claimed to hold them.
 * - The required capability must be held by the agent AND allowed by the
 *   merchant policy (defense in depth).
 */
export class CapabilityService {
  constructor(private readonly db: AppDatabase) {}

  getAgent(agentId: string): AgentRow | null {
    return this.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get() ?? null;
  }

  listAgents(): AgentRow[] {
    return this.db.select().from(schema.agents).all().sort((a, b) => a.id.localeCompare(b.id));
  }

  check(
    agentId: string,
    actionType: ActionType,
    requestedTokens: readonly string[],
    policy: PolicyRow,
  ): CapabilityCheckResult {
    const agent = this.getAgent(agentId);
    const violations: RuleViolation[] = [];
    const required = capabilityForAction(actionType);

    if (!agent) {
      violations.push(violation('AGENT_NOT_FOUND', `Unknown agent "${agentId}".`));
      return { agent: null, violations, granted: [], required };
    }
    if (!agent.active) {
      violations.push(violation('AGENT_INACTIVE', `Agent "${agentId}" is inactive.`));
    }

    if (isPrivilegedCapability(required) || !isGrantableCapability(required)) {
      violations.push(
        violation(
          'CAPABILITY_PRIVILEGED',
          `Action "${actionType}" requires privileged capability "${required}", which no agent may hold.`,
        ),
      );
    } else {
      if (!(agent.capabilities as string[]).includes(required)) {
        violations.push(
          violation('CAPABILITY_NOT_GRANTED', `Agent "${agentId}" does not hold capability "${required}".`),
        );
      }
      if (!(policy.allowedCapabilities as string[]).includes(required)) {
        violations.push(
          violation(
            'CAPABILITY_NOT_GRANTED',
            `Merchant policy v${policy.version} does not allow capability "${required}".`,
          ),
        );
      }
    }

    for (const token of requestedTokens) {
      if (typeof token !== 'string' || token.length === 0) {
        violations.push(violation('CAPABILITY_UNKNOWN', 'Malformed capability token; failing closed.'));
        continue;
      }
      if (!isKnownCapability(token)) {
        violations.push(violation('CAPABILITY_UNKNOWN', `Unknown capability "${token}"; failing closed.`));
      } else if (isPrivilegedCapability(token)) {
        violations.push(
          violation('CAPABILITY_PRIVILEGED', `Requested privileged capability "${token}" — escalation attempt.`),
        );
      } else if (!(agent.capabilities as string[]).includes(token)) {
        violations.push(
          violation('CAPABILITY_NOT_GRANTED', `Agent "${agentId}" does not hold requested capability "${token}".`),
        );
      }
    }

    const granted = (agent.capabilities as string[]).filter(isGrantableCapability);
    return { agent, violations, granted, required };
  }
}