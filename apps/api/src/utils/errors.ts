// apps/api/src/utils/errors.ts
/**
 * Domain-level failure with a stable machine code. Routes map these to
 * structured JSON errors; they never leak stack traces (§57, §66).
 * Security-sensitive failures always fail CLOSED.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
