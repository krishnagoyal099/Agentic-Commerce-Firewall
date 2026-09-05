// apps/api/src/routes/carts.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../appContext';
import { ItemSpecSchema, parseOrThrow } from '../schemas';
import { toCartDTO } from '../utils/dto';
import { DomainError } from '../utils/errors';

const CreateCartSchema = z
  .object({
    agentId: z.string().min(1).max(64),
    mandateId: z.string().min(1).max(64),
    items: z.array(ItemSpecSchema).min(1).max(50),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

const AddItemsSchema = CreateCartSchema.omit({ mandateId: true }).extend({ mandateId: z.string().min(1).max(64) });

export function registerCartRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/carts', async (request) => {
    const body = parseOrThrow(CreateCartSchema, request.body);
    return ctx.gateway.submitPayload(
      { type: 'cart.create', items: body.items },
      { agentId: body.agentId, mandateId: body.mandateId, protocol: 'REST', idempotencyKey: body.idempotencyKey },
      { execute: true },
    );
  });

  app.get('/api/carts/:id', async (request) => {
    const { id } = request.params as { id: string };
    const view = ctx.carts.getCart(id);
    if (view === null) throw new DomainError('CART_NOT_FOUND', `Cart ${id} does not exist.`);
    return { cart: toCartDTO(view) };
  });

  app.post('/api/carts/:id/items', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(AddItemsSchema, request.body);
    return ctx.gateway.submitPayload(
      { type: 'cart.add_item', cartId: id, items: body.items },
      { agentId: body.agentId, mandateId: body.mandateId, protocol: 'REST', idempotencyKey: body.idempotencyKey },
      { execute: true },
    );
  });
}