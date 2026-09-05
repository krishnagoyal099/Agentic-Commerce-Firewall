// packages/shared/src/capabilities.ts
/**
 * Capability security (§17).
 * Only GRANTABLE capabilities may ever be held by an agent.
 * PRIVILEGED capabilities are administrative and unreachable from any agent path.
 * Unknown capability tokens fail CLOSED.
 */
export const GRANTABLE_CAPABILITIES = [
  'catalog.read',
  'cart.create',
  'cart.modify',
  'payment.create',
  'upsell.create',
] as const;
export type GrantableCapability = (typeof GRANTABLE_CAPABILITIES)[number];

export const PRIVILEGED_CAPABILITIES = [
  'refund.create',
  'merchant.payout.modify',
  'settlement_account.modify',
  'policy.modify',
  'mandate.modify',
] as const;
export type PrivilegedCapability = (typeof PRIVILEGED_CAPABILITIES)[number];

export type Capability = GrantableCapability | PrivilegedCapability;

/** Any capability string arriving from an untrusted agent is a token until validated. */
export type CapabilityToken = string;

export function isGrantableCapability(token: CapabilityToken): token is GrantableCapability {
  return (GRANTABLE_CAPABILITIES as readonly string[]).includes(token);
}

export function isPrivilegedCapability(token: CapabilityToken): token is PrivilegedCapability {
  return (PRIVILEGED_CAPABILITIES as readonly string[]).includes(token);
}

export function isKnownCapability(token: CapabilityToken): token is Capability {
  return isGrantableCapability(token) || isPrivilegedCapability(token);
}