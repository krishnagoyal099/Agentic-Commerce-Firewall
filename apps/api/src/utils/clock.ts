// apps/api/src/utils/clock.ts
/**
 * Deterministic time abstraction (§67).
 * Every service receives a Clock via injection; nothing calls new Date() directly
 * in domain code. FixedClock enables temporal authorization tests and the
 * payment-timeout / mandate-expiry / slow-drift attacks.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Mutable test/demo clock. `now()` returns defensive copies. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }
}