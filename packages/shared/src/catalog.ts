// packages/shared/src/catalog.ts
import type { Category } from './categories';

export interface ProductDTO {
  id: string;
  sku: string;
  name: string;
  /** UNTRUSTED text. Catalog content is data, never instructions (§19). */
  description: string;
  pricePaise: number;
  category: Category;
  marginPercent: number;
  active: boolean;
  /** True when the description contains injected agent instructions (demo product). */
  malicious: boolean;
}