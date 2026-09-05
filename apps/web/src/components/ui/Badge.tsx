// apps/web/src/components/ui/Badge.tsx
import type { ReactNode } from 'react';

export type BadgeTone = 'allow' | 'review' | 'block' | 'neutral' | 'accent' | 'onDark';

const TONES: Record<BadgeTone, string> = {
  allow: 'border-transparent bg-allow text-white',
  review: 'border-transparent bg-review text-white',
  block: 'border-transparent bg-block text-white',
  neutral: 'border-ink-line bg-canvas-mist text-ink-soft',
  accent: 'border-brand-200 bg-brand-50 text-brand-600',
  onDark: 'border-white/25 bg-white/15 text-white',
};

export function decisionTone(decision: string): BadgeTone {
  if (decision === 'ALLOW') return 'allow';
  if (decision === 'HUMAN_APPROVAL' || decision === 'REAUTHORIZE') return 'review';
  if (decision === 'BLOCK') return 'block';
  return 'neutral';
}

export function paymentTone(state: string): BadgeTone {
  if (state === 'CAPTURED') return 'allow';
  if (state === 'FAILED' || state === 'CANCELLED' || state === 'REFUNDED') return 'block';
  if (state === 'UNKNOWN') return 'review';
  return 'neutral';
}

/**
 * Reconciliation outcome -> tone. This was a substring test for 'SAFE', which
 * only ever matched SAFE_RETRY — so PROVIDER_FAILED, the one outcome that says
 * the money did not move as expected, was painted green.
 */
export function resolutionTone(resolution: string): BadgeTone {
  if (resolution === 'PROVIDER_FAILED') return 'block';
  if (resolution === 'SAFE_RETRY' || resolution === 'NOT_APPLICABLE') return 'review';
  if (
    resolution === 'ALREADY_CAPTURED_NO_RETRY' ||
    resolution === 'RESUMED_AND_CAPTURED' ||
    resolution === 'SYNCED_FROM_PROVIDER'
  ) {
    return 'allow';
  }
  return 'neutral';
}

export function Badge({
  tone = 'neutral',
  children,
  mono = false,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide ${
        TONES[tone]
      } ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  );
}
