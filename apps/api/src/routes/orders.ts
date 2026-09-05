// apps/api/src/routes/orders.ts
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PaymentDTO } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { parseOrThrow } from '../schemas';
import * as schema from '../db/schema';
import { toOrderDTO } from '../utils/dto';
import { DomainError } from '../utils/errors';

const CreateOrderSchema = z
  .object({
    agentId: z.string().min(1).max(64),
    mandateId: z.string().min(1).max(64),
    cartId: z.string().min(1).max(64),
    discountPaise: z.number().int().min(0).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

function paymentOf(data: unknown): PaymentDTO | null {
  if (typeof data === 'object' && data !== null && 'state' in data && 'id' in data) {
    return data as PaymentDTO;
  }
  return null;
}

export function registerOrderRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Full checkout: payment.create proposal → firewall → execution → order.
  app.post('/api/orders', async (request) => {
    const body = parseOrThrow(CreateOrderSchema, request.body);
    const cart = ctx.carts.getCart(body.cartId);
    if (cart === null) throw new DomainError('CART_NOT_FOUND', `Cart ${body.cartId} does not exist.`);
    const discountPaise = body.discountPaise ?? 0;
    const amountPaise = cart.subtotalPaise - discountPaise;
    const result = await ctx.gateway.submitPayload(
      { type: 'payment.create', cartId: body.cartId, amountPaise, discountPaise },
      { agentId: body.agentId, mandateId: body.mandateId, protocol: 'REST', idempotencyKey: body.idempotencyKey },
      { execute: true },
    );
    const payment = paymentOf(result.data);
    const orderRow =
      payment?.orderId !== null && payment?.orderId !== undefined
        ? ctx.db.select().from(schema.orders).where(eq(schema.orders.id, payment.orderId)).get()
        : null;
    return { ...result, payment, order: !orderRow ? null : toOrderDTO(orderRow) };
  });

  app.get('/api/orders', async () => {
    const rows = ctx.db.select().from(schema.orders).orderBy(desc(schema.orders.createdAt)).limit(100).all();
    return { orders: rows.map(toOrderDTO) };
  });

  app.get('/api/orders/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = ctx.db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!row) throw new DomainError('ORDER_NOT_FOUND', `Order ${id} does not exist.`);
    return { order: toOrderDTO(row) };
  });
}