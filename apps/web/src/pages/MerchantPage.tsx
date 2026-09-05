// apps/web/src/pages/MerchantPage.tsx
import { CatalogEditor } from '../components/merchant/CatalogEditor';
import { PolicyEditorPanel } from '../components/firewall/PolicyEditorPanel';

/**
 * Everything the merchant controls, in one place: what they sell, and the
 * policy that bounds what an agent may do with it. Neither is reachable by an
 * agent — catalog writes and policy writes both reject agent actors.
 */
export function MerchantPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-ink-line bg-white px-6 py-5 shadow-card">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-brand-600">
          Merchant console
        </p>
        <h1 className="display mt-2 text-3xl text-ink">
          <span className="font-extrabold">You</span> <span className="font-light">decide what is for sale.</span>
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
          The catalog and the policy are merchant data. Agents may read the catalog and propose
          against it; they can never edit either. Change a price here and the next authorization
          prices from this table — an agent&apos;s claimed price still loses.
        </p>
      </div>
      <CatalogEditor />
      <PolicyEditorPanel />
    </div>
  );
}
