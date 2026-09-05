// apps/api/src/attacks/types.ts
import type { AttackName, AttackReport, AttackStep } from '@acsf/shared';
import type { ServiceContext } from '../context';
import type { ProtocolGateway } from '../protocol/ProtocolGateway';
import type { MCPCommerceAdapter } from '../protocol/mcp/MCPCommerceAdapter';

export interface AttackDeps {
  ctx: ServiceContext;
  gateway: ProtocolGateway;
  adapter: MCPCommerceAdapter;
}

export type AttackRunner = (deps: AttackDeps) => Promise<AttackReport>;

export function attackStep(label: string, detail: string): AttackStep {
  return { label, detail };
}