// apps/web/src/components/ui/Button.tsx
import type { ReactNode } from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'onDark';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-500 text-white font-semibold shadow-lift hover:bg-brand-600 active:bg-brand-700',
  secondary: 'border border-ink-line bg-white text-ink font-medium hover:border-brand-300 hover:bg-brand-50',
  danger: 'border border-block/25 bg-block/10 text-block font-semibold hover:bg-block/15',
  ghost: 'text-ink-soft font-medium hover:bg-brand-50 hover:text-ink',
  onDark: 'bg-white text-brand-700 font-semibold hover:bg-brand-50',
};

export function Button({
  variant = 'secondary',
  loading = false,
  disabled = false,
  onClick,
  children,
  className = '',
}: {
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-all disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <Spinner size={13} /> : null}
      {children}
    </button>
  );
}
