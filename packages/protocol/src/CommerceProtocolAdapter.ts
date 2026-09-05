// packages/protocol/src/CommerceProtocolAdapter.ts
import type { ProtocolName } from '@acsf/shared';
import type {
  DiscoverInput,
  DiscoverResult,
  ProtocolInvocation,
  ProtocolResult,
  ProtocolToolDescriptor,
  ProposalInput,
  ProposalResult,
} from './types';

/**
 * The single contract every commerce-protocol ingress must satisfy (§5).
 *
 * The firewall never knows which protocol delivered a command: adapters
 * translate protocol-specific envelopes into the same validated domain
 * actions and always route financial actions through the AuthorizationEngine.
 *
 * Implemented adapters:
 *   - MCPCommerceAdapter   (apps/api/src/protocol/mcp/MCPCommerceAdapter.ts)
 *
 * Documented future adapters (interfaces below describe the required shape;
 * they are NOT implemented in this MVP and we do not claim otherwise):
 *   - ACPCommerceAdapter   — Agent Commerce Protocol sessions
 *   - AP2CommerceAdapter   — agentic payment negotiation flows
 *   - X402CommerceAdapter  — HTTP-402 payment-required flows
 *
 * A new adapter requires ONLY: implement this interface, register it with the
 * ProtocolGateway, and every firewall rule applies unchanged.
 */
export interface CommerceProtocolAdapter {
  /** Human-readable adapter identifier, e.g. "mcp". */
  readonly name: string;
  /** Protocol name recorded on every decision and audit event. */
  readonly protocolName: ProtocolName;
  /** Safe tool surface this adapter exposes to agents. */
  listTools(): ProtocolToolDescriptor[];
  /** Catalog discovery — read-only, capability-checked. */
  discover(input: DiscoverInput): Promise<DiscoverResult>;
  /** Submit a commerce proposal — always evaluated by the AuthorizationEngine. */
  executeProposal(input: ProposalInput): Promise<ProposalResult>;
  /** Generic tool dispatch used by the gateway demo and audit trail. */
  invoke(request: ProtocolInvocation): Promise<ProtocolResult>;
}