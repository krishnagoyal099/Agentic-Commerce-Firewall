// apps/api/src/services/CatalogAdminService.ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CATEGORIES, formatINR, rupeesToPaise, type ProductDTO } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { ProductRow } from '../db/schema';
import * as schema from '../db/schema';
import { DEMO_PRODUCTS } from '../db/seed';
import { DomainError } from '../utils/errors';
import { sha256JSON } from '../utils/hash';
import { newId } from '../utils/ids';
import type { AuditService } from './AuditService';
import type { Clock } from '../utils/clock';
import { toProductDTO } from './CatalogService';

export const ProductCreateSchema = z
  .object({
    sku: z.string().trim().min(2).max(40),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000).default(''),
    priceRupees: z.number().int().min(1).max(10_000_000),
    category: z.enum(CATEGORIES),
    marginPercent: z.number().int().min(0).max(100),
    active: z.boolean().default(true),
  })
  .strict();

export const ProductUpdateSchema = ProductCreateSchema.partial().strict();

export type ProductCreateInput = z.input<typeof ProductCreateSchema>;
export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>;

/**
 * Merchant catalog administration (§18).
 *
 * The catalog is MERCHANT data. Agents read it and can never write it:
 * `catalog.write` is not a capability at all, there is no protocol tool for it,
 * and every method here refuses an actor that names a registered agent — the
 * same guard PolicyEngine applies to policy edits. Product descriptions stay
 * untrusted data: nothing written here is ever parsed as an instruction, and a
 * merchant cannot mark a product "malicious" (that flag belongs to the seeded
 * injection demo).
 *
 * Prices are stored in paise and always come from this table at authorization
 * time, so editing a price changes what the firewall charges — never what an
 * agent may claim.
 */
export class CatalogAdminService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly merchantId: string,
  ) {}

  /** Catalog writes are a merchant action. An agent actor fails closed. */
  private assertNotAgent(actor: string): void {
    const agentRow = this.db.select().from(schema.agents).where(eq(schema.agents.id, actor)).get();
    if (agentRow) {
      throw new DomainError(
        'CATALOG_MODIFICATION_BY_AGENT',
        `Agents may not modify the catalog. "${actor}" is an agent.`,
      );
    }
  }

  private rowOrThrow(productId: string): ProductRow {
    const row = this.db.select().from(schema.products).where(eq(schema.products.id, productId)).get();
    if (!row) {
      throw new DomainError('PRODUCT_NOT_FOUND', `Product ${productId} does not exist.`);
    }
    return row;
  }

  private assertSkuFree(sku: string, exceptProductId: string | null): void {
    const clash = this.db
      .select()
      .from(schema.products)
      .all()
      .find((row) => row.sku.toLowerCase() === sku.toLowerCase() && row.id !== exceptProductId);
    if (clash !== undefined) {
      throw new DomainError('DUPLICATE_SKU', `SKU "${sku}" is already used by ${clash.name}.`);
    }
  }

  /**
   * Everything that references this product — the deletion blockers. Cart
   * lines and growth opportunities hold real foreign keys; orders keep a JSON
   * list of product ids. All three are history, so all three block a delete.
   */
  referenceCount(productId: string): { cartLines: number; orders: number; opportunities: number } {
    const cartLines = this.db
      .select({ id: schema.cartItems.id })
      .from(schema.cartItems)
      .where(eq(schema.cartItems.productId, productId))
      .all().length;
    const orders = this.db
      .select({ productIds: schema.orders.productIds })
      .from(schema.orders)
      .all()
      .filter((row) => row.productIds.includes(productId)).length;
    const opportunities = this.db
      .select({ productId: schema.growthOpportunities.productId, anchorProductId: schema.growthOpportunities.anchorProductId })
      .from(schema.growthOpportunities)
      .all()
      .filter((row) => row.productId === productId || row.anchorProductId === productId).length;
    return { cartLines, orders, opportunities };
  }

  /** True when any history references the product, so it may not be deleted. */
  private isReferenced(refs: { cartLines: number; orders: number; opportunities: number }): boolean {
    return refs.cartLines > 0 || refs.orders > 0 || refs.opportunities > 0;
  }

  createProduct(rawInput: ProductCreateInput, actor: string): ProductDTO {
    this.assertNotAgent(actor);
    const parsed = ProductCreateSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_PRODUCT',
        `Product failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const input = parsed.data;
    this.assertSkuFree(input.sku, null);

    const row: ProductRow = {
      id: newId('prod'),
      merchantId: this.merchantId,
      sku: input.sku,
      name: input.name,
      description: input.description,
      pricePaise: rupeesToPaise(input.priceRupees),
      category: input.category,
      marginPercent: input.marginPercent,
      active: input.active,
      // Merchants cannot author the prompt-injection demo product.
      malicious: false,
      createdAt: this.clock.now().toISOString(),
    };
    this.db.insert(schema.products).values(row).run();
    this.audit.append({
      actor,
      eventType: 'CATALOG_CHANGE',
      action: 'catalog.product.created',
      reason: `Merchant added ${row.name} (${row.category}) at ${formatINR(row.pricePaise)}.`,
      inputHash: sha256JSON(input),
      payload: { productId: row.id, sku: row.sku, category: row.category, pricePaise: row.pricePaise },
    });
    return toProductDTO(row);
  }

  updateProduct(productId: string, rawPatch: ProductUpdateInput, actor: string): ProductDTO {
    this.assertNotAgent(actor);
    const parsed = ProductUpdateSchema.safeParse(rawPatch);
    if (!parsed.success) {
      throw new DomainError(
        'INVALID_PRODUCT',
        `Product patch failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      throw new DomainError('INVALID_PRODUCT', 'Product patch contained no changes.');
    }
    const current = this.rowOrThrow(productId);
    if (patch.sku !== undefined) this.assertSkuFree(patch.sku, productId);

    const next: ProductRow = {
      ...current,
      sku: patch.sku ?? current.sku,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      pricePaise: patch.priceRupees !== undefined ? rupeesToPaise(patch.priceRupees) : current.pricePaise,
      category: patch.category ?? current.category,
      marginPercent: patch.marginPercent ?? current.marginPercent,
      active: patch.active ?? current.active,
    };
    this.db.update(schema.products).set(next).where(eq(schema.products.id, productId)).run();

    const changes: string[] = [];
    if (next.pricePaise !== current.pricePaise) {
      changes.push(`price ${formatINR(current.pricePaise)} → ${formatINR(next.pricePaise)}`);
    }
    if (next.category !== current.category) changes.push(`category ${current.category} → ${next.category}`);
    if (next.marginPercent !== current.marginPercent) {
      changes.push(`margin ${current.marginPercent}% → ${next.marginPercent}%`);
    }
    if (next.active !== current.active) changes.push(next.active ? 'reactivated' : 'deactivated');
    if (next.name !== current.name) changes.push(`renamed to ${next.name}`);
    if (next.sku !== current.sku) changes.push(`sku ${current.sku} → ${next.sku}`);
    if (next.description !== current.description) changes.push('description edited');

    this.audit.append({
      actor,
      eventType: 'CATALOG_CHANGE',
      action: 'catalog.product.updated',
      reason: `Merchant updated ${next.name}: ${changes.length > 0 ? changes.join('; ') : 'no effective change'}.`,
      inputHash: sha256JSON(patch),
      payload: { productId, changes },
    });
    return toProductDTO(next);
  }

  /**
   * Hard delete. Refused while any cart line or order references the product —
   * history is never rewritten to make a catalog edit convenient. Deactivate
   * instead: an inactive product cannot be added to a new cart.
   */
  deleteProduct(productId: string, actor: string): { deleted: true; productId: string } {
    this.assertNotAgent(actor);
    const row = this.rowOrThrow(productId);
    const refs = this.referenceCount(productId);
    if (this.isReferenced(refs)) {
      throw new DomainError(
        'PRODUCT_IN_USE',
        `${row.name} appears in ${refs.orders} order(s), ${refs.cartLines} cart line(s) and ${refs.opportunities} growth opportunity(ies); deactivate it instead so history stays intact.`,
      );
    }
    this.db.delete(schema.products).where(eq(schema.products.id, productId)).run();
    this.audit.append({
      actor,
      eventType: 'CATALOG_CHANGE',
      action: 'catalog.product.deleted',
      reason: `Merchant removed ${row.name} from the catalog.`,
      inputHash: sha256JSON({ productId }),
      payload: { productId, sku: row.sku },
    });
    return { deleted: true, productId };
  }

  /**
   * Puts the shipped demo catalog back: the seed products are restored to their
   * original values, and anything the merchant added is deleted when unused, or
   * deactivated when it appears in history.
   */
  restoreDemoCatalog(actor: string): { restored: number; deactivated: number; removed: number } {
    this.assertNotAgent(actor);
    const now = this.clock.now().toISOString();
    const demoIds = new Set(DEMO_PRODUCTS.map((product) => product.id));
    let restored = 0;
    let deactivated = 0;
    let removed = 0;

    for (const demo of DEMO_PRODUCTS) {
      const existing = this.db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, demo.id))
        .get();
      const row: ProductRow = { ...demo, merchantId: this.merchantId, createdAt: existing?.createdAt ?? now };
      if (existing) {
        this.db.update(schema.products).set(row).where(eq(schema.products.id, demo.id)).run();
      } else {
        this.db.insert(schema.products).values(row).run();
      }
      restored += 1;
    }

    for (const row of this.db.select().from(schema.products).all()) {
      if (demoIds.has(row.id)) continue;
      const refs = this.referenceCount(row.id);
      if (this.isReferenced(refs)) {
        if (row.active) {
          this.db
            .update(schema.products)
            .set({ ...row, active: false })
            .where(eq(schema.products.id, row.id))
            .run();
          deactivated += 1;
        }
      } else {
        this.db.delete(schema.products).where(eq(schema.products.id, row.id)).run();
        removed += 1;
      }
    }

    this.audit.append({
      actor,
      eventType: 'CATALOG_CHANGE',
      action: 'catalog.restored',
      reason: `Demo catalog restored: ${restored} seed product(s) reset, ${removed} merchant product(s) removed, ${deactivated} kept but deactivated because they appear in history.`,
      inputHash: sha256JSON({ restored, removed, deactivated }),
      payload: { restored, removed, deactivated },
    });
    return { restored, deactivated, removed };
  }
}
