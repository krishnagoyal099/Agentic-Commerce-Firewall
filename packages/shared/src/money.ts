// packages/shared/src/money.ts
/**
 * Money is ALWAYS represented as integer paise (1 INR = 100 paise).
 * Floating point never touches authorization, payments, or budget math.
 */
export const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

/** Indian-locale grouping, e.g. 779800 -> "₹7,798", 12470000 -> "₹1,24,700". */
export function formatINR(paise: number): string {
  // Sign outside the symbol: "-₹5", not "₹-5".
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.abs(paise) / PAISE_PER_RUPEE;
  const hasFraction = paise % PAISE_PER_RUPEE !== 0;
  return `${sign}₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}