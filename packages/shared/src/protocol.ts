// packages/shared/src/protocol.ts
/**
 * Protocol identity (§3, §5). The firewall is protocol-agnostic: it only ever
 * sees a validated AgentAction plus the protocol name that delivered it.
 * ACP / AP2 / x402 are future adapters behind the same interface — documented
 * in packages/protocol, never claimed as implemented.
 */
import type { Decision } from './decisions';

export const PROTOCOL_NAMES = ['MCP', 'REST', 'INTERNAL'] as const;
export type ProtocolName = (typeof PROTOCOL_NAMES)[number];

/** The exact safe tool surface exposed over MCP (§4, §35). */
export const MCP_TOOL_NAMES = [
  'search_products',
  'get_product',
  'create_cart',
  'get_cart',
  'add_cart_item',
  'propose_purchase',
  'request_authorization',
  'get_decision_receipt',
  'create_payment',
  'get_payment_status',
] as const;
export type MCPToolName = (typeof MCP_TOOL_NAMES)[number];

export const PROTOCOL_REQUEST_STATUSES = ['ACCEPTED', 'DENIED', 'ERROR'] as const;
export type ProtocolRequestStatus = (typeof PROTOCOL_REQUEST_STATUSES)[number];

export interface ProtocolRequestDTO {
  id: string;
  requestId: string;
  protocol: ProtocolName;
  tool: string;
  agentId: string;
  status: ProtocolRequestStatus;
  decision: Decision | null;
  decisionId: string | null;
  summary: string;
  createdAt: string;
}