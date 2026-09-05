// apps/api/src/providers/RazorpayPaymentProvider.ts
import { formatINR, type PaymentState, type ProviderPaymentResult } from '@acsf/shared';
import type { PaymentProvider, ProviderCreateRequest, ProviderQueryResult } from './PaymentProvider';
import { ProviderRejectedError, ProviderTimeoutError, ProviderUnavailableError } from './PaymentProvider';

const REQUEST_TIMEOUT_MS = 15_000;

interface RazorpayResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function mapPaymentStatus(status: string): PaymentState {
  switch (status) {
    case 'authorized':
      return 'AUTHORIZED';
    case 'captured':
    case 'paid':
      return 'CAPTURED';
    case 'failed':
      return 'FAILED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
}

type RazorpayPaymentItem = { id?: unknown; status?: unknown; amount?: unknown };

/**
 * An order can carry several payment attempts. Taking items[0] meant a failed
 * first attempt could mask a later successful one, so a captured payment was
 * reported as failed. Rank by how much the status commits us instead.
 */
const PAYMENT_PRECEDENCE: readonly string[] = ['captured', 'authorized', 'refunded', 'created', 'failed'];

function pickPayment(items: readonly unknown[]): RazorpayPaymentItem | undefined {
  const rank = (item: RazorpayPaymentItem): number => {
    const index = PAYMENT_PRECEDENCE.indexOf(typeof item.status === 'string' ? item.status : '');
    return index === -1 ? PAYMENT_PRECEDENCE.length : index;
  };
  return [...(items as RazorpayPaymentItem[])]
    .filter((item) => typeof item?.id === 'string')
    .sort((a, b) => rank(a) - rank(b))[0];
}

function mapOrderStatus(status: string): PaymentState {
  switch (status) {
    case 'paid':
      return 'CAPTURED';
    case 'attempted':
      return 'PENDING';
    case 'created':
    default:
      return 'PENDING';
  }
}

/**
 * Razorpay adapter (optional — enabled only when RAZORPAY_KEY_ID and
 * RAZORPAY_KEY_SECRET are configured; §26). Implemented against Razorpay's
 * REST API with native fetch and HTTP Basic auth — no SDK dependency.
 *
 * Mapping (documented, honest):
 *   createPayment  → POST /orders                → PENDING (order created; buyer-side
 *                    payment completion is external in real usage)
 *   queryPayment   → GET  /orders/:id (+ /payments) → AUTHORIZED/CAPTURED/FAILED/PENDING
 *   queryByReceipt → GET  /orders?receipt=…      → resolves order by our receipt id
 *   capturePayment → GET /orders/:id/payments, then POST /payments/:id/capture
 *   cancelPayment  → POST /orders/:id/cancel
 *
 * This adapter targets Razorpay test mode; it compiles and runs without keys
 * but is only selected when credentials are present. The mock provider is the
 * demo default.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(keyId: string, keySecret: string, baseUrl = 'https://api.razorpay.com/v1') {
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.baseUrl = baseUrl;
    this.authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<RazorpayResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Authorization: `Basic ${this.authHeader}`,
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      } catch {
        parsed = { raw: text };
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderTimeoutError(`Razorpay request to ${path} timed out.`);
      }
      throw new ProviderUnavailableError(
        `Razorpay request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classifies a non-2xx response.
   *
   * A non-2xx is NOT automatically a decline. 5xx, 429 and 408 mean "we could
   * not get an answer", and 401/403 mean "we were not allowed to ask" — in all
   * of those the payment's fate is unknown. Mapping them to
   * ProviderRejectedError made PaymentService drive the payment to a terminal
   * FAILED and release the cart, so a provider hiccup during capture stranded
   * money that had actually moved, and the agent was free to charge again.
   * Only a 4xx Razorpay authored as a business error is a real rejection.
   */
  private failFor(res: { status: number; body: unknown }, fallback: string): Error {
    const message = this.describeError(res.body, fallback);
    const ambiguous = res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 401 || res.status === 403;
    return ambiguous
      ? new ProviderUnavailableError(`${message} (HTTP ${res.status}; outcome unknown)`)
      : new ProviderRejectedError(message);
  }

  /**
   * Same rule for reads, and stricter: only a 404 (or a genuinely empty result)
   * may report "not found". Reconciliation treats found:false as proof the
   * charge never landed — it marks the payment FAILED, fails the order and
   * releases the cart back to open, which is exactly the double-charge path.
   */
  private queryFailure(res: { status: number; body: unknown }, fallback: string): Error {
    return new ProviderUnavailableError(
      `${this.describeError(res.body, fallback)} (HTTP ${res.status}; cannot confirm whether the payment exists)`,
    );
  }

  private describeError(body: unknown, fallback: string): string {
    if (typeof body === 'object' && body !== null) {
      const error = (body as { error?: { description?: unknown } }).error;
      if (error && typeof error.description === 'string') {
        return error.description;
      }
    }
    return fallback;
  }

  async createPayment(request: ProviderCreateRequest): Promise<ProviderPaymentResult> {
    const res = await this.request('POST', '/orders', {
      amount: request.amountPaise,
      currency: request.currency,
      receipt: request.receipt,
      notes: request.notes ?? {},
    });
    if (!res.ok) {
      throw this.failFor(res, 'Razorpay order creation failed.');
    }
    const order = res.body as { id?: unknown; status?: unknown };
    if (typeof order.id !== 'string') {
      // A 2xx with no id is ambiguous, not a decline: the order may well
      // exist. Unavailable keeps the payment recoverable via reconciliation.
      throw new ProviderUnavailableError('Razorpay order creation returned no order id; outcome unknown.');
    }
    return {
      providerPaymentId: order.id,
      state: 'PENDING',
      amountPaise: request.amountPaise,
      message: `Razorpay order ${order.id} created (${typeof order.status === 'string' ? order.status : 'created'}); awaiting payment completion.`,
      capturedAt: null,
    };
  }

  async queryPayment(providerPaymentId: string): Promise<ProviderQueryResult> {
    const orderRes = await this.request('GET', `/orders/${encodeURIComponent(providerPaymentId)}`);
    if (!orderRes.ok) {
      if (orderRes.status !== 404) {
        throw this.queryFailure(orderRes, `Razorpay order lookup failed for ${providerPaymentId}.`);
      }
      return {
        found: false,
        payment: null,
        message: `Order ${providerPaymentId} does not exist at the provider (HTTP 404).`,
      };
    }
    const payRes = await this.request('GET', `/orders/${encodeURIComponent(providerPaymentId)}/payments`);
    if (payRes.ok) {
      const items = (payRes.body as { items?: unknown[] }).items ?? [];
      // Highest-precedence attempt wins, not items[0]: an order with a failed
      // attempt followed by a successful one used to resolve to the FAILED one,
      // which marked a captured payment failed and released the cart.
      const first = pickPayment(items);
      if (first !== undefined && typeof first.id === 'string') {
        const state = mapPaymentStatus(typeof first.status === 'string' ? first.status : '');
        return {
          found: true,
          payment: {
            providerPaymentId: first.id,
            state,
            amountPaise: typeof first.amount === 'number' ? first.amount : 0,
            message: `Razorpay payment ${first.id} is ${String(first.status)}.`,
            capturedAt: null,
          },
          message: `Razorpay payment ${first.id} is ${String(first.status)}.`,
        };
      }
    }
    const order = orderRes.body as { status?: unknown; amount?: unknown };
    const state = mapOrderStatus(typeof order.status === 'string' ? order.status : '');
    return {
      found: true,
      payment: {
        providerPaymentId: providerPaymentId,
        state,
        amountPaise: typeof order.amount === 'number' ? order.amount : 0,
        message: `Razorpay order ${providerPaymentId} status ${String(order.status ?? 'created')}.`,
        capturedAt: null,
      },
      message: `Razorpay order ${providerPaymentId} status ${String(order.status ?? 'created')}.`,
    };
  }

  async queryByReceipt(receipt: string): Promise<ProviderQueryResult> {
    const res = await this.request('GET', `/orders?receipt=${encodeURIComponent(receipt)}&count=5`);
    if (!res.ok) {
      // A failed search is not an empty search — see queryFailure().
      throw this.queryFailure(res, `Razorpay receipt lookup failed for ${receipt}.`);
    }
    const items = (res.body as { items?: Array<{ id?: unknown }> }).items ?? [];
    const first = items[0];
    if (first === undefined || typeof first.id !== 'string') {
      return { found: false, payment: null, message: `No Razorpay order with receipt ${receipt}.` };
    }
    return this.queryPayment(first.id);
  }

  async capturePayment(providerPaymentId: string, amountPaise: number): Promise<ProviderPaymentResult> {
    const payRes = await this.request('GET', `/orders/${encodeURIComponent(providerPaymentId)}/payments`);
    if (!payRes.ok) {
      throw this.queryFailure(payRes, 'Razorpay payment lookup failed during capture.');
    }
    const items =
      (payRes.body as { items?: Array<{ id?: unknown; status?: unknown }> }).items ?? [];
    // Already captured? Report that rather than deferring — otherwise a retry
    // after a lost capture response looks like "nothing to capture yet".
    const captured = items.find((p) => p.status === 'captured');
    if (captured !== undefined && typeof captured.id === 'string') {
      return {
        providerPaymentId: captured.id,
        state: 'CAPTURED',
        amountPaise,
        message: `Razorpay payment ${captured.id} was already captured; no second capture attempted.`,
        capturedAt: null,
      };
    }
    const target = items.find((p) => p.status === 'authorized');
    if (target === undefined || typeof target.id !== 'string') {
      return {
        providerPaymentId,
        state: 'PENDING',
        amountPaise,
        message: 'No authorized payment on the order yet; capture deferred.',
        capturedAt: null,
      };
    }
    const capRes = await this.request('POST', `/payments/${encodeURIComponent(target.id)}/capture`, {
      amount: amountPaise,
      currency: 'INR',
    });
    if (!capRes.ok) {
      throw this.failFor(capRes, 'Razorpay capture failed.');
    }
    return {
      providerPaymentId: target.id,
      state: 'CAPTURED',
      amountPaise,
      message: `Captured ${formatINR(amountPaise)} via Razorpay payment ${target.id}.`,
      capturedAt: new Date().toISOString(),
    };
  }

  async cancelPayment(providerPaymentId: string): Promise<ProviderPaymentResult> {
    const res = await this.request('POST', `/orders/${encodeURIComponent(providerPaymentId)}/cancel`);
    if (!res.ok) {
      throw this.failFor(res, 'Razorpay cancel failed.');
    }
    return {
      providerPaymentId,
      state: 'CANCELLED',
      amountPaise: 0,
      message: `Razorpay order ${providerPaymentId} cancelled.`,
      capturedAt: null,
    };
  }
}