// packages/shared/src/actors.ts
/**
 * Canonical actor ids and names (§16).
 */
export const ACTOR_IDS = {
  merchantId: 'demo-merchant',
  merchantName: 'Marathon Pro Shop',
  buyerAgentId: 'buyer-agent-01',
  growthAgentId: 'growth-agent-01',
  adversarialAgentId: 'adversarial-agent-01',
  demoUserId: 'demo-user',
  userId: 'demo-user',
} as const;

export const DEMO_INTENT = 'I need running shoes for my upcoming marathon under ₹8,000.';

export interface AgentDTO {
  id: string;
  name: string;
  agentType: import('./states').AgentType;
  capabilities: string[];
  active: boolean;
  createdAt: string;
}
