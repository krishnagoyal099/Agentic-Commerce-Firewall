// apps/web/src/components/merchant/CatalogEditor.tsx
import { useState, type ReactNode } from 'react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  formatINR,
  paiseToRupees,
  type Category,
  type ProductDTO,
} from '@acsf/shared';
import { errMessage } from '../../api/client';
import {
  useCatalogRestore,
  useProductCreate,
  useProductDelete,
  useProductUpdate,
  useProducts,
} from '../../hooks';
import type { ProductCreateInput } from '../../types';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

const MERCHANT_ACTOR = 'demo-merchant-admin';

const BLANK: ProductCreateInput = {
  sku: '',
  name: '',
  description: '',
  priceRupees: 0,
  category: 'running_shoes',
  marginPercent: 40,
  active: true,
};

const FIELD =
  'w-full rounded-xl border border-ink-line bg-canvas-mist px-2.5 py-1.5 text-xs text-ink outline-none transition-colors focus:border-brand-400 focus:bg-white';

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[10px] font-bold uppercase tracking-widest text-ink-faint">
      {label}
      <div className="mt-1 font-normal normal-case tracking-normal">{children}</div>
    </label>
  );
}

export function CatalogEditor() {
  const catalog = useProducts();
  const create = useProductCreate();
  const update = useProductUpdate();
  const remove = useProductDelete();
  const restore = useCatalogRestore();

  const [draft, setDraft] = useState<ProductCreateInput>(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const products = catalog.data?.products ?? [];
  const usage = catalog.data?.usage ?? {};
  const busy = create.isPending || update.isPending || remove.isPending || restore.isPending;
  const [validationError, setValidationError] = useState<string | null>(null);
  // Each mutation keeps its error until IT runs again, and create won the fixed
  // ?? chain — so a DUPLICATE_SKU from an earlier add sat next to a later green
  // success notice, and hid every subsequent delete/deactivate failure. Reset
  // the others whenever one is fired, and read whichever actually has an error.
  const error =
    validationError ??
    create.error ??
    update.error ??
    remove.error ??
    restore.error ??
    catalog.error ??
    null;

  const clearMutationErrors = (): void => {
    setValidationError(null);
    create.reset();
    update.reset();
    remove.reset();
    restore.reset();
  };

  const startEdit = (product: ProductDTO): void => {
    setEditingId(product.id);
    setNotice(null);
    clearMutationErrors();
    setDraft({
      sku: product.sku,
      name: product.name,
      description: product.description,
      // Rounded: paiseToRupees is a bare divide, and the server schema requires
      // an integer, so a sub-rupee price would 400 without the user touching
      // the price field.
      priceRupees: Math.round(paiseToRupees(product.pricePaise)),
      category: product.category,
      marginPercent: product.marginPercent,
      active: product.active,
    });
  };

  const cancel = (): void => {
    setEditingId(null);
    setDraft(BLANK);
  };

  const submit = (): void => {
    setNotice(null);
    clearMutationErrors();
    // Was a bare `return` — the button simply did nothing, with no message.
    if (draft.sku.trim().length < 2) {
      setValidationError('SKU must be at least 2 characters.');
      return;
    }
    if (draft.name.trim().length < 2) {
      setValidationError('Product name must be at least 2 characters.');
      return;
    }
    if (!Number.isInteger(draft.priceRupees) || draft.priceRupees < 1) {
      setValidationError('Price must be a whole number of rupees, at least ₹1.');
      return;
    }
    if (editingId !== null) {
      update.mutate(
        { productId: editingId, updatedBy: MERCHANT_ACTOR, patch: draft },
        {
          onSuccess: (result) => {
            setNotice(`${result.product.name} updated. New carts price it at ${formatINR(result.product.pricePaise)}.`);
            cancel();
          },
        },
      );
      return;
    }
    create.mutate(
      { updatedBy: MERCHANT_ACTOR, product: draft },
      {
        onSuccess: (result) => {
          setNotice(`${result.product.name} added to the catalog. Agents can now discover it.`);
          cancel();
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <Card
        title="Catalog"
        subtitle="What this merchant sells. Agents read it; no agent — and no protocol tool — can write it."
        right={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{products.length} products</Badge>
            <Button
              loading={restore.isPending}
              onClick={() =>
                restore.mutate(
                  { updatedBy: MERCHANT_ACTOR },
                  {
                    onSuccess: (r) =>
                      setNotice(
                        `Demo catalog restored — ${r.restored} seed product(s) reset, ${r.removed} removed, ${r.deactivated} deactivated because they appear in history.`,
                      ),
                  },
                )
              }
            >
              Restore demo catalog
            </Button>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-widest text-ink-faint">
                <th className="pb-2 pr-3">product</th>
                <th className="pb-2 pr-3">category</th>
                <th className="pb-2 pr-3 text-right">price</th>
                <th className="pb-2 pr-3 text-right">margin</th>
                <th className="pb-2 pr-3">status</th>
                <th className="pb-2 pr-3">used in</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const refs = usage[product.id] ?? { cartLines: 0, orders: 0, opportunities: 0 };
                const locked = refs.cartLines > 0 || refs.orders > 0 || refs.opportunities > 0;
                return (
                  <tr
                    key={product.id}
                    className={`border-t border-ink-line/70 ${
                      editingId === product.id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <td className="py-2 pr-3">
                      <p className="font-semibold text-ink">{product.name}</p>
                      <p className="font-mono text-[10px] text-ink-faint">{product.sku}</p>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone="neutral" mono>
                        {product.category}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-ink">
                      {formatINR(product.pricePaise)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-ink-soft">
                      {product.marginPercent}%
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={product.active ? 'allow' : 'neutral'}>
                          {product.active ? 'ACTIVE' : 'INACTIVE'}
                        </Badge>
                        {product.malicious ? <Badge tone="block">INJECTION DEMO</Badge> : null}
                      </div>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[10px] text-ink-faint">
                      {locked ? `${refs.orders} orders · ${refs.cartLines} lines${refs.opportunities > 0 ? ` · ${refs.opportunities} upsells` : ''}` : '—'}
                    </td>
                    <td className="py-2">
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" onClick={() => startEdit(product)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            update.mutate({
                              productId: product.id,
                              updatedBy: MERCHANT_ACTOR,
                              patch: { active: !product.active },
                            })
                          }
                        >
                          {product.active ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy || locked}
                          onClick={() =>
                            remove.mutate({ productId: product.id, updatedBy: MERCHANT_ACTOR })
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {products.length === 0 ? (
            <p className="py-3 text-xs text-ink-faint">
              The catalog is empty — add a product, or restore the demo catalog.
            </p>
          ) : null}
        </div>
        <p className="mt-3 text-[10px] text-ink-faint">
          A product that appears in an order can be deactivated but never deleted — the audit chain
          and order history are append-only.
        </p>
      </Card>

      <Card
        title={editingId !== null ? 'Edit product' : 'Add product'}
        subtitle="Prices are stored server-side in paise and re-read at authorization; an agent's claimed price can never win."
        right={
          editingId !== null ? (
            <Button variant="ghost" onClick={cancel}>
              Cancel edit
            </Button>
          ) : null
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Labelled label="Name">
            <input
              className={FIELD}
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Labelled>
          <Labelled label="SKU">
            <input
              className={`${FIELD} font-mono`}
              value={draft.sku}
              maxLength={40}
              onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
            />
          </Labelled>
          <Labelled label="Category">
            <select
              className={FIELD}
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}
            >
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Price ₹">
            <input
              className={`${FIELD} font-mono`}
              inputMode="numeric"
              value={draft.priceRupees === 0 ? '' : String(draft.priceRupees)}
              onChange={(e) =>
                setDraft({ ...draft, priceRupees: Number(e.target.value.replace(/[^\d]/g, '') || 0) })
              }
            />
          </Labelled>
          <Labelled label="Margin %">
            <input
              className={`${FIELD} font-mono`}
              inputMode="numeric"
              value={String(draft.marginPercent)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  marginPercent: Math.min(100, Number(e.target.value.replace(/[^\d]/g, '') || 0)),
                })
              }
            />
          </Labelled>
          <Labelled label="Available to agents">
            <button
              type="button"
              onClick={() => setDraft({ ...draft, active: !draft.active })}
              className={`w-full rounded-xl px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                draft.active
                  ? 'bg-allow text-white'
                  : 'border border-ink-line bg-canvas-mist text-ink-soft'
              }`}
            >
              {draft.active ? 'ACTIVE' : 'INACTIVE'}
            </button>
          </Labelled>
          <div className="md:col-span-2 xl:col-span-3">
            <Labelled label="Description (untrusted data — never parsed as instructions)">
              <textarea
                className={`${FIELD} resize-y`}
                rows={2}
                maxLength={2000}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Labelled>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={busy} onClick={submit}>
            {editingId !== null ? 'Save changes' : 'Add to catalog'}
          </Button>
          <span className="font-mono text-[10px] text-ink-faint">as {MERCHANT_ACTOR}</span>
        </div>
        {notice !== null ? <p className="mt-3 text-xs text-allow">{notice}</p> : null}
        {error !== null ? <p className="mt-3 text-xs text-block">{errMessage(error)}</p> : null}
      </Card>
    </div>
  );
}
