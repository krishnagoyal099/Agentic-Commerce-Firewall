// apps/api/src/routes/products.ts  (MODIFIED — merchant catalog administration)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../appContext';
import { ProductCreateSchema, ProductUpdateSchema } from '../services/CatalogAdminService';
import { DomainError } from '../utils/errors';

/**
 * Catalog writes carry an explicit actor, exactly like policy edits. The
 * service refuses any actor that names a registered agent, so there is no path
 * — HTTP, MCP or otherwise — by which an agent edits what it is allowed to buy.
 */
const CreateBodySchema = z
  .object({ updatedBy: z.string().min(1).max(64), product: ProductCreateSchema })
  .strict();

const UpdateBodySchema = z
  .object({ updatedBy: z.string().min(1).max(64), patch: ProductUpdateSchema })
  .strict();

const ActorBodySchema = z.object({ updatedBy: z.string().min(1).max(64) }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown, code: string): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new DomainError(code, `Request failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

export function registerProductRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/products', async (request) => {
    const query = (request.query as { query?: string }).query ?? null;
    const products =
      query !== null && query.length > 0 ? ctx.catalog.searchProducts(query) : ctx.catalog.listProducts();
    // usage tells the console which products can be deleted and which must
    // only be deactivated, because history may never be rewritten.
    const usage = Object.fromEntries(
      products.map((product) => [product.id, ctx.catalogAdmin.referenceCount(product.id)]),
    );
    return { products, count: products.length, usage };
  });

  app.post('/api/products', async (request, reply) => {
    const body = parse(CreateBodySchema, request.body, 'INVALID_PRODUCT');
    const product = ctx.catalogAdmin.createProduct(body.product, body.updatedBy);
    reply.status(201);
    return { product };
  });

  app.patch('/api/products/:productId', async (request) => {
    const { productId } = request.params as { productId: string };
    const body = parse(UpdateBodySchema, request.body, 'INVALID_PRODUCT');
    return { product: ctx.catalogAdmin.updateProduct(productId, body.patch, body.updatedBy) };
  });

  app.delete('/api/products/:productId', async (request) => {
    const { productId } = request.params as { productId: string };
    const body = parse(ActorBodySchema, request.body, 'INVALID_PRODUCT');
    return ctx.catalogAdmin.deleteProduct(productId, body.updatedBy);
  });

  app.post('/api/products/restore-demo', async (request) => {
    const body = parse(ActorBodySchema, request.body, 'INVALID_PRODUCT');
    return ctx.catalogAdmin.restoreDemoCatalog(body.updatedBy);
  });
}
