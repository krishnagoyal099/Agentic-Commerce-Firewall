// apps/web/src/components/ui/QueryError.tsx
import { errMessage } from '../../api/client';

/**
 * A failed query is not an empty result.
 *
 * Every panel used to render `data ?? []` and fall through to its own empty
 * state, so with the API down the Audit explorer said "No audit events yet",
 * the protocol log said "0 accepted · 0 denied", and the Authority Map asserted
 * the merchant DENIED capabilities it actually allows. For an audit console
 * that is the worst possible failure mode: it reports health it has not
 * verified. Render this instead of the empty state whenever `error` is set.
 */
export function QueryError({ error, what }: { error: unknown; what: string }) {
  if (error === null || error === undefined) return null;
  return (
    <p className="py-3 text-xs text-block">
      Could not load {what}: {errMessage(error)}. This is a load failure, not an empty result — check the API on :3001.
    </p>
  );
}
