// apps/api/src/utils/hash.ts
import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays
 * order-preserving, undefined dropped. Used for cart canonicalization (§25),
 * audit input hashes, and the audit hash chain (§44). Reordered JSON
 * properties produce the SAME canonical string — this is exactly what the
 * "reordered JSON → same hash" test requires.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  switch (t) {
    case 'string':
      return JSON.stringify(value);
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new Error('Cannot canonicalize non-finite number');
      }
      return JSON.stringify(value);
    }
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJSON(v)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`Cannot canonicalize value of type ${t}`);
  }
}

export function sha256JSON(value: unknown): string {
  return sha256Hex(canonicalJSON(value));
}