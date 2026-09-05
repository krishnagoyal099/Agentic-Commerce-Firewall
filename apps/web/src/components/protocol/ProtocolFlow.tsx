// apps/web/src/components/protocol/ProtocolFlow.tsx
import { Card } from '../ui/Card';

const STEPS = [
  'AI BUYER',
  'MCP INGRESS',
  'COMMERCE TOOLS',
  'FIREWALL',
  'PAYMENT',
] as const;

export function ProtocolFlow() {
  return (
    <Card title="Protocol Gateway" subtitle="The protocol layer never bypasses authorization">
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((step, i) => (
          <li key={step} className="flex items-center gap-2">
            <span className="rounded-xl border border-ink-line bg-canvas-mist px-3 py-1.5 font-mono text-[11px] tracking-wide text-ink">
              {step}
            </span>
            {i < STEPS.length - 1 ? <span className="text-brand-600">→</span> : null}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[10px] text-ink-faint">
        search_products · get_product · create_cart · get_cart · add_cart_item · propose_purchase ·
        request_authorization · get_decision_receipt · create_payment · get_payment_status — privileged tools are not exposed
      </p>
    </Card>
  );
}