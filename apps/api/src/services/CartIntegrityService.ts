// apps/api/src/services/CartIntegrityService.ts
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/client';
import * as schema from '../db/schema';
import { sha256JSON } from '../utils/hash';

export interface CanonicalCartItem {
  productId: string;
  quantity: number;
  unitPricePaise: number;
  options: Record<string, string>;
}

export interface CartLine {
  productId: string;
  quantity: number;
  unitPricePaise: number;
  options: Record<string, string>;
}

/**
 * Cart integrity (§25). Canonical form: items sorted by productId, each
 * {productId, quantity, unitPricePaise, options} with recursively key-sorted
 * JSON serialization, plus the cart-level discount. SHA-256 over that
 * canonical serialization. Reordered JSON properties produce the SAME hash;
 * any quantity / price / item / discount change produces a different hash.
 */
export class CartIntegrityService {
  constructor(private readonly db: AppDatabase) {}

  computeHash(items: readonly CanonicalCartItem[], discountPaise: number): string {
    const sorted = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
    return sha256JSON({ discountPaise, items: sorted });
  }

  computeHashFromLines(lines: readonly CartLine[], discountPaise: number): string {
    return this.computeHash(
      lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPricePaise: line.unitPricePaise,
        options: line.options,
      })),
      discountPaise,
    );
  }

  /** Fresh hash computed from CURRENT database state (never trusts a stored hash). */
  hashForCart(cartId: string): string | null {
    const cart = this.db.select().from(schema.carts).where(eq(schema.carts.id, cartId)).get();
    if (!cart) return null;
    const items = this.db
      .select()
      .from(schema.cartItems)
      .where(eq(schema.cartItems.cartId, cartId))
      .all();
    return this.computeHashFromLines(
      items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
        options: item.options ?? {},
      })),
      cart.discountPaise,
    );
  }
}