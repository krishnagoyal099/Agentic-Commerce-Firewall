// apps/api/src/utils/ids.ts
import { randomBytes } from 'node:crypto';

/**
 * Prefixed opaque ids (dec_…, pay_…, evt_…). Collision probability is
 * negligible (18 hex chars = 72 bits). Ids are never authority — only
 * references. Deterministic seeding passes explicit ids where needed.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`;
}