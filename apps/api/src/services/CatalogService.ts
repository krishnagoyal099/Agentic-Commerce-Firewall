// apps/api/src/services/CatalogService.ts
import { eq } from 'drizzle-orm';
import type { Category, ProductDTO, RuleViolation } from '@acsf/shared';
import { CART_ITEM_MAX_QUANTITY, violation } from '@acsf/shared';
import type { CartItemSpec } from '@acsf/shared';
import type { AppDatabase } from '../db/client';
import type { ProductRow } from '../db/schema';
import * as schema from '../db/schema';

export interface ResolvedCartItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPricePaise: number;
  category: Category;
  marginPercent: number;
  options: Record<string, string>;
  claimedPriceMismatch: boolean;
}

export interface ItemResolution {
  items: ResolvedCartItem[];
  violations: RuleViolation[];
  subtotalPaise: number;
}

export function toProductDTO(row: ProductRow): ProductDTO {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    pricePaise: row.pricePaise,
    category: row.category,
    marginPercent: row.marginPercent,
    active: row.active,
    malicious: row.malicious,
  };
}

/**
 * Catalog access + server-side price resolution (§18–§19).
 * Descriptions are UNTRUSTED DATA: nothing in this service (or anywhere in
 * the authorization path) parses catalog text as instructions. Search matches
 * name / category / sku only — never description — so injected "AI
 * INSTRUCTIONS" in product text can influence nothing.
 */
export class CatalogService {
  constructor(private readonly db: AppDatabase) {}

  listProducts(): ProductDTO[] {
    return this.db
      .select()
      .from(schema.products)
      .all()
      .map(toProductDTO)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  searchProducts(query: string | null): ProductDTO[] {
    const rows = this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.active, true))
      .all();
    const tokens = (query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const filtered =
      tokens.length === 0
        ? rows
        : rows.filter((row) =>
            tokens.some(
              (token) =>
                row.name.toLowerCase().includes(token) ||
                row.category.includes(token) ||
                row.sku.toLowerCase().includes(token),
            ),
          );
    return filtered
      .map(toProductDTO)
      .sort((a, b) => a.pricePaise - b.pricePaise || a.id.localeCompare(b.id));
  }

  getProduct(productId: string): ProductDTO | null {
    const row = this.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .get();
    return row ? toProductDTO(row) : null;
  }

  private rowById(productId: string): ProductRow | undefined {
    return this.db.select().from(schema.products).where(eq(schema.products.id, productId)).get();
  }

  /**
   * Resolves untrusted item specs against the trusted catalog. Unit prices are
   * ALWAYS taken from the catalog; a claimed price that disagrees is recorded
   * as PRICE_TAMPER (server-side pricing wins — the mismatch never changes the
   * charged amount, it only flags the attempt).
   * Duplicate productIds within one action are merged (quantities summed).
   */
  resolveItems(specs: readonly CartItemSpec[]): ItemResolution {
    const violations: RuleViolation[] = [];
    const byProduct = new Map<string, ResolvedCartItem>();

    for (const spec of specs) {
      if (typeof spec.productId !== 'string' || spec.productId.length === 0) {
        violations.push(violation('MALFORMED_PROPOSAL', 'Item productId must be a non-empty string.'));
        continue;
      }
      const quantity = spec.quantity;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > CART_ITEM_MAX_QUANTITY) {
        violations.push(
          violation(
            'MALFORMED_PROPOSAL',
            `Item ${spec.productId} quantity must be an integer between 1 and ${CART_ITEM_MAX_QUANTITY}.`,
          ),
        );
        continue;
      }
      const row = this.rowById(spec.productId);
      if (!row) {
        violations.push(violation('PRODUCT_NOT_FOUND', `Product ${spec.productId} does not exist.`));
        continue;
      }
      if (!row.active) {
        violations.push(violation('PRODUCT_INACTIVE', `Product ${row.name} is inactive.`));
        continue;
      }
      const mismatch =
        spec.claimedUnitPricePaise !== undefined &&
        (typeof spec.claimedUnitPricePaise !== 'number' || !Number.isInteger(spec.claimedUnitPricePaise) ||
          spec.claimedUnitPricePaise !== row.pricePaise);
      if (spec.claimedUnitPricePaise !== undefined && !Number.isInteger(spec.claimedUnitPricePaise)) {
        violations.push(
          violation('MALFORMED_PROPOSAL', `Item ${spec.productId} claimedUnitPricePaise must be an integer.`),
        );
        continue;
      }
      if (
        spec.claimedUnitPricePaise !== undefined &&
        spec.claimedUnitPricePaise !== row.pricePaise
      ) {
        violations.push(
          violation(
            'PRICE_TAMPER',
            `Agent claimed unit price ${spec.claimedUnitPricePaise} paise for ${row.name}; catalog price is ${row.pricePaise} paise. Server-side pricing wins.`,
          ),
        );
      }
      const options = spec.options ?? {};
      const existing = byProduct.get(row.id);
      const optionsToUse = existing ? existing.options : options;
      byProduct.set(row.id, {
        productId: row.id,
        productName: row.name,
        quantity: (existing?.quantity ?? 0) + quantity,
        unitPricePaise: row.pricePaise,
        category: row.category,
        marginPercent: row.marginPercent,
        options: optionsToUse,
        claimedPriceMismatch: (existing?.claimedPriceMismatch ?? false) || mismatch,
      });
    }

    const items = [...byProduct.values()].sort((a, b) => a.productId.localeCompare(b.productId));
    const subtotalPaise = items.reduce((sum, item) => sum + item.unitPricePaise * item.quantity, 0);
    return { items, violations, subtotalPaise };
  }
}