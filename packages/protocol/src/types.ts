// packages/protocol/src/types.ts
import type { Decision, DecisionReceipt, ProductDTO } from '@acsf/shared';
import type { CartItemSpec } from '@acsf/shared';
import type { ProtocolName } from '@acsf/shared';

export interface ProtocolToolDescriptor {
  name: string;
  title: string;
  description: string;
}

export interface DiscoverInput {
  requestId: string;
  agentId: string;
  mandateId: string | null;
  query: string | null;
}

export interface DiscoverResult {
  requestId: string;
  status: 'OK' | 'DENIED';
  products: ProductDTO[];
  message: string;
}

export interface ProposalInput {
  requestId: string;
  agentId: string;
  mandateId: string | null;
  cartId: string | null;
  items: CartItemSpec[];
  discountPaise: number;
  idempotencyKey: string;
  note: string | null;
}

export interface ProposalResult {
  requestId: string;
  status: 'OK' | 'DENIED' | 'ERROR';
  decision: Decision | null;
  decisionId: string | null;
  receipt: DecisionReceipt | null;
  error: { code: string; message: string } | null;
}

export type ProtocolResultStatus = 'OK' | 'DENIED' | 'ERROR';

export interface ProtocolResult {
  requestId: string;
  tool: string;
  status: ProtocolResultStatus;
  decision: Decision | null;
  /** Set when the result came from a gateway evaluation that produced a decision. */
  decisionId?: string | null;
  data: unknown;
  error: { code: string; message: string } | null;
}

export interface ProtocolInvocation {
  requestId: string;
  agentId: string;
  mandateId: string | null;
  tool: string;
  args: Record<string, unknown>;
}