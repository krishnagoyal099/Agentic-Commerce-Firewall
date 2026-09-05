// apps/api/src/schemas/index.ts
/**
 * Zod schemas for ALL external input (§57) plus the single payload→AgentAction
 * construction boundary. Transport-supplied fields (protocol, actionId,
 * timestamp, generated idempotency keys) are ALWAYS set server-side — a client
 * cannot spoof its protocol or forge action identity.
 */
import { z } from 'zod';
import type { AgentAction, ProtocolName } from '@acsf/shared';
import { DomainError } from '../utils/errors';

export const ItemSpecSchema = z
  .object({
    productId: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(99),
    claimedUnitPricePaise: z.number().int().min(0).optional(),
    options: z.record(z.string().min(1).max(32), z.string().max(100)).optional(),
  })
  .strict();
export type ItemSpec = z.infer<typeof ItemSpecSchema>;

const itemsField = z.array(ItemSpecSchema).min(1).max(50);
const cartIdField = z.string().min(1).max(64);
const paymentIdField = z.string().min(1).max(64);
const patchField = z.record(z.string(), z.unknown());

export const ActionPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('catalog.read'), query: z.string().max(200).nullish() }).strict(),
  z.object({ type: z.literal('cart.create'), items: itemsField }).strict(),
  z.object({ type: z.literal('cart.add_item'), cartId: cartIdField, items: itemsField }).strict(),
  z
    .object({
      type: z.literal('cart.modify'),
      cartId: cartIdField,
      items: z.array(ItemSpecSchema).min(1).max(50).optional(),
      discountPaise: z.number().int().min(0).optional(),
      reason: z.string().max(200).nullish(),
    })
    .strict(),
  z
    .object({
      type: z.literal('upsell.create'),
      cartId: cartIdField,
      items: itemsField,
      pitch: z.string().max(300).nullish(),
    })
    .strict(),
  z
    .object({
      type: z.literal('payment.create'),
      cartId: cartIdField,
      amountPaise: z.number().int().min(0),
      discountPaise: z.number().int().min(0),
      orderId: z.string().max(64).nullish(),
    })
    .strict(),
  z.object({ type: z.literal('payment.query'), paymentId: paymentIdField }).strict(),
  z.object({ type: z.literal('payment.reconcile'), paymentId: paymentIdField }).strict(),
  z.object({ type: z.literal('refund.create'), paymentId: paymentIdField, amountPaise: z.number().int().min(1) }).strict(),
  z.object({ type: z.literal('policy.modify'), policyPatch: patchField }).strict(),
  z.object({ type: z.literal('mandate.modify'), mandatePatch: patchField }).strict(),
  z.object({ type: z.literal('merchant.payout.modify'), details: patchField }).strict(),
  z.object({ type: z.literal('settlement_account.modify'), details: patchField }).strict(),
]);
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

export interface ActionBuildContext {
  agentId: string;
  mandateId: string | null;
  protocol: ProtocolName;
  requestedCapabilities: readonly string[];
  actionId: string;
  idempotencyKey: string;
  timestamp: string;
}

/** Payload → typed AgentAction. Exhaustive over the discriminated union. */
export function buildAgentAction(payload: ActionPayload, context: ActionBuildContext): AgentAction {
  const base = {
    actionId: context.actionId,
    agentId: context.agentId,
    mandateId: context.mandateId,
    protocol: context.protocol,
    requestedCapabilities: context.requestedCapabilities,
    timestamp: context.timestamp,
    idempotencyKey: context.idempotencyKey,
  };
  switch (payload.type) {
    case 'catalog.read':
      return { ...base, type: 'catalog.read', cartId: null, query: payload.query ?? null };
    case 'cart.create':
      return { ...base, type: 'cart.create', cartId: null, items: payload.items };
    case 'cart.add_item':
      return { ...base, type: 'cart.add_item', cartId: payload.cartId, items: payload.items };
    case 'cart.modify':
      return {
        ...base,
        type: 'cart.modify',
        cartId: payload.cartId,
        items: payload.items,
        discountPaise: payload.discountPaise,
        reason: payload.reason ?? null,
      };
    case 'upsell.create':
      return { ...base, type: 'upsell.create', cartId: payload.cartId, items: payload.items, pitch: payload.pitch ?? null };
    case 'payment.create':
      return {
        ...base,
        type: 'payment.create',
        cartId: payload.cartId,
        amountPaise: payload.amountPaise,
        discountPaise: payload.discountPaise,
        orderId: payload.orderId ?? null,
      };
    case 'payment.query':
      return { ...base, type: 'payment.query', cartId: null, paymentId: payload.paymentId };
    case 'payment.reconcile':
      return { ...base, type: 'payment.reconcile', cartId: null, paymentId: payload.paymentId };
    case 'refund.create':
      return { ...base, type: 'refund.create', cartId: null, paymentId: payload.paymentId, amountPaise: payload.amountPaise };
    case 'policy.modify':
      return { ...base, type: 'policy.modify', cartId: null, policyPatch: payload.policyPatch };
    case 'mandate.modify':
      return { ...base, type: 'mandate.modify', cartId: null, mandatePatch: payload.mandatePatch };
    case 'merchant.payout.modify':
      return { ...base, type: 'merchant.payout.modify', cartId: null, details: payload.details };
    case 'settlement_account.modify':
      return { ...base, type: 'settlement_account.modify', cartId: null, details: payload.details };
  }
}

/** Parse external input or fail closed with a structured DomainError. */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new DomainError('INVALID_REQUEST', `Request validation failed: ${details}`);
  }
  return result.data;
}