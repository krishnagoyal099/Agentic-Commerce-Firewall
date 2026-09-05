// apps/api/src/protocol/mcp/MCPCommerceAdapter.ts
/**
 * Implements @acsf/protocol's CommerceProtocolAdapter over the ProtocolGateway.
 * This is the exact code path used by BOTH the stdio MCP server and the REST
 * protocol demo — one adapter, one gateway, one AuthorizationEngine (§56).
 */
import { formatINR, renderReceipt, type Decision, type ProductDTO } from '@acsf/shared';
import type {
  CommerceProtocolAdapter,
  DiscoverInput,
  DiscoverResult,
  ProposalInput,
  ProposalResult,
  ProtocolInvocation,
  ProtocolResult,
  ProtocolToolDescriptor,
} from '@acsf/protocol';
import type { ServiceContext } from '../../context';
import { toCartDTO } from '../../utils/dto';
import type { GatewayResult, ProtocolGateway } from '../ProtocolGateway';
import { MCP_TOOLS, ToolArgSchemas } from './tools';

export class MCPCommerceAdapter implements CommerceProtocolAdapter {
  readonly name = 'mcp';
  readonly protocolName = 'MCP' as const;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly gateway: ProtocolGateway,
  ) {}

  listTools(): ProtocolToolDescriptor[] {
    return MCP_TOOLS;
  }

  async discover(input: DiscoverInput): Promise<DiscoverResult> {
    const result = await this.gateway.submitPayload(
      { type: 'catalog.read', query: input.query },
      { agentId: input.agentId, mandateId: input.mandateId, protocol: 'MCP' },
      { execute: false },
    );
    const products = this.productsOf(result.data);
    return {
      requestId: result.protocolRequestId,
      status: result.decision === 'ALLOW' && result.status !== 'ERROR' ? 'OK' : 'DENIED',
      products,
      message:
        result.error?.message ??
        (result.decision === 'ALLOW' ? `${products.length} product(s) found.` : (result.reason ?? 'Denied by the firewall.')),
    };
  }

  async executeProposal(input: ProposalInput): Promise<ProposalResult> {
    const context = {
      agentId: input.agentId,
      mandateId: input.mandateId,
      protocol: this.protocolName,
      idempotencyKey: input.idempotencyKey,
    };
    if (input.cartId === null) {
      const result = await this.gateway.submitPayload({ type: 'cart.create', items: input.items }, context, { execute: false });
      return this.toProposalResult(input.requestId, result);
    }
    const cart = this.ctx.carts.getCart(input.cartId);
    if (cart === null) {
      return {
        requestId: input.requestId,
        status: 'ERROR',
        decision: null,
        decisionId: null,
        receipt: null,
        error: { code: 'CART_NOT_FOUND', message: `Cart ${input.cartId} does not exist.` },
      };
    }
    const amountPaise = cart.subtotalPaise - input.discountPaise;
    const result = await this.gateway.submitPayload(
      { type: 'payment.create', cartId: input.cartId, amountPaise, discountPaise: input.discountPaise },
      context,
      { execute: false },
    );
    return this.toProposalResult(input.requestId, result);
  }

  async invoke(request: ProtocolInvocation): Promise<ProtocolResult> {
    const base = { requestId: request.requestId, tool: request.tool };
    switch (request.tool) {
      case 'search_products': {
        const parsed = ToolArgSchemas.search_products.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const result = await this.gateway.submitPayload(
          { type: 'catalog.read', query: parsed.data.query ?? null },
          { agentId: parsed.data.agentId, mandateId: parsed.data.mandateId ?? null, protocol: 'MCP' },
          { execute: false },
        );
        return this.toResult(base, result);
      }

      case 'get_product': {
        const parsed = ToolArgSchemas.get_product.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const evalResult = await this.gateway.submitPayload(
          { type: 'catalog.read', query: parsed.data.productId },
          { agentId: parsed.data.agentId, mandateId: request.mandateId, protocol: 'MCP' },
          { execute: false },
        );
        // Fetched only when the firewall allowed the read; this used to run
        // unconditionally and ship the product with a DENIED status.
        const allowed = evalResult.decision === 'ALLOW';
        const product = allowed ? this.ctx.catalog.getProduct(parsed.data.productId) : null;
        return {
          requestId: evalResult.protocolRequestId,
          tool: 'get_product',
          status: allowed ? 'OK' : 'DENIED',
          decision: evalResult.decision,
          data: allowed ? { product } : null,
          error: evalResult.error,
        };
      }

      case 'create_cart': {
        const parsed = ToolArgSchemas.create_cart.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const result = await this.gateway.submitPayload(
          { type: 'cart.create', items: parsed.data.items },
          { agentId: parsed.data.agentId, mandateId: parsed.data.mandateId, protocol: 'MCP', idempotencyKey: parsed.data.idempotencyKey },
          { execute: true },
        );
        return this.toResult(base, result);
      }

      case 'get_cart': {
        const parsed = ToolArgSchemas.get_cart.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        if (this.ctx.capabilities.getAgent(parsed.data.agentId) === null) {
          return this.errorResult(base, 'UNKNOWN_AGENT', `Unknown agent "${parsed.data.agentId}"; failing closed.`);
        }
        const view = this.ctx.carts.getCart(parsed.data.cartId);
        // Every WRITE path enforces the cart<->mandate binding via
        // AuthorizationEngine.loadCart; this read did not, so any registered
        // agent could pull another user's cart — lines, prices, totals and the
        // authorized hash — just by naming its id.
        if (view !== null && view.cart.mandateId !== parsed.data.mandateId) {
          return this.errorResult(
            base,
            'CART_NOT_OWNED',
            `Cart ${parsed.data.cartId} was not created under mandate ${parsed.data.mandateId}.`,
          );
        }
        const note = this.gateway.note(
          'get_cart',
          parsed.data.agentId,
          view === null
            ? `Read cart ${parsed.data.cartId} (not found).`
            : `Read cart ${parsed.data.cartId} (${view.lines.length} line(s), total ${formatINR(view.totalPaise)}).`,
        );
        return {
          requestId: note.id,
          tool: 'get_cart',
          status: 'OK',
          decision: null,
          data: view === null ? null : toCartDTO(view),
          error: null,
        };
      }

      case 'add_cart_item': {
        const parsed = ToolArgSchemas.add_cart_item.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const result = await this.gateway.submitPayload(
          { type: 'cart.add_item', cartId: parsed.data.cartId, items: parsed.data.items },
          { agentId: parsed.data.agentId, mandateId: parsed.data.mandateId, protocol: 'MCP', idempotencyKey: parsed.data.idempotencyKey },
          { execute: true },
        );
        return this.toResult(base, result);
      }

      case 'propose_purchase': {
        const parsed = ToolArgSchemas.propose_purchase.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const cart = this.ctx.carts.getCart(parsed.data.cartId);
        if (cart === null) {
          return this.errorResult(base, 'CART_NOT_FOUND', `Cart ${parsed.data.cartId} does not exist.`);
        }
        const discountPaise = parsed.data.discountPaise ?? 0;
        const result = await this.gateway.submitPayload(
          {
            type: 'payment.create',
            cartId: parsed.data.cartId,
            amountPaise: cart.subtotalPaise - discountPaise,
            discountPaise,
          },
          {
            agentId: parsed.data.agentId,
            mandateId: parsed.data.mandateId,
            protocol: 'MCP',
            idempotencyKey: parsed.data.idempotencyKey,
          },
          { execute: false },
        );
        return this.toResult(base, result);
      }

      case 'request_authorization': {
        const parsed = ToolArgSchemas.request_authorization.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const row = this.ctx.authorization.getDecision(parsed.data.decisionId);
        if (row === null) {
          return this.errorResult(base, 'DECISION_NOT_FOUND', `Decision ${parsed.data.decisionId} does not exist.`);
        }
        const note = this.gateway.note(
          'request_authorization',
          parsed.data.agentId,
          `Authorization status check for decision ${parsed.data.decisionId}.`,
        );
        const authorizes = row.decision === 'ALLOW' || (row.decision === 'HUMAN_APPROVAL' && row.approvedAt !== null);
        return {
          requestId: note.id,
          tool: 'request_authorization',
          status: 'OK',
          decision: row.decision,
          data: {
            decisionId: row.id,
            decision: row.decision,
            reason: row.reason,
            approved: row.approvedAt !== null,
            consumed: row.consumedAt !== null,
            authorizesExecution: authorizes && row.consumedAt === null,
          },
          error: null,
        };
      }

      case 'get_decision_receipt': {
        const parsed = ToolArgSchemas.get_decision_receipt.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const receipt = this.ctx.authorization.getDecisionReceipt(parsed.data.decisionId);
        if (receipt === null) {
          return this.errorResult(base, 'DECISION_NOT_FOUND', `Decision ${parsed.data.decisionId} does not exist.`);
        }
        const note = this.gateway.note(
          'get_decision_receipt',
          parsed.data.agentId,
          `Decision receipt requested for ${parsed.data.decisionId}.`,
        );
        return {
          requestId: note.id,
          tool: 'get_decision_receipt',
          status: 'OK',
          decision: receipt.decision,
          data: { receipt, text: renderReceipt(receipt) },
          error: null,
        };
      }

      case 'create_payment': {
        const parsed = ToolArgSchemas.create_payment.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const result = await this.gateway.submitPayload(
          {
            type: 'payment.create',
            cartId: parsed.data.cartId,
            amountPaise: parsed.data.amountPaise,
            discountPaise: parsed.data.discountPaise,
          },
          {
            agentId: parsed.data.agentId,
            mandateId: parsed.data.mandateId,
            protocol: 'MCP',
            idempotencyKey: parsed.data.idempotencyKey,
          },
          { execute: true },
        );
        return this.toResult(base, result);
      }

      case 'get_payment_status': {
        const parsed = ToolArgSchemas.get_payment_status.safeParse(request.args);
        if (!parsed.success) return this.invalidArgs(base, parsed.error);
        const result = await this.gateway.submitPayload(
          { type: 'payment.query', paymentId: parsed.data.paymentId },
          { agentId: parsed.data.agentId, mandateId: request.mandateId, protocol: 'MCP' },
          { execute: false },
        );
        return this.toResult(base, result);
      }

      default: {
        // §39 — protocol boundary denial for any unexposed tool.
        const note = this.gateway.noteDeniedTool(
          request.tool,
          request.agentId,
          `Tool "${request.tool}" is not exposed by the MCP adapter; denied at the protocol boundary.`,
        );
        return {
          requestId: note.id,
          tool: request.tool,
          status: 'DENIED',
          decision: null,
          data: null,
          error: {
            code: 'TOOL_NOT_EXPOSED',
            message: `Tool "${request.tool}" is not exposed. Privileged and unknown tools are rejected before any domain or payment access.`,
          },
        };
      }
    }
  }

  // ---------- private ----------

  private toResult(base: { requestId: string; tool: string }, result: GatewayResult): ProtocolResult & { decisionId: string | null } {
    return {
      requestId: result.protocolRequestId,
      tool: base.tool,
      status: result.status === 'ERROR' ? 'ERROR' : result.decision === 'ALLOW' ? 'OK' : 'DENIED',
      decision: result.decision,
      data: result.data,
      error: result.error,
      decisionId: result.decisionId,
    };
  }

  private toProposalResult(requestId: string, result: GatewayResult): ProposalResult {
    return {
      requestId: result.protocolRequestId ?? requestId,
      status: result.status === 'ERROR' ? 'ERROR' : result.decision === 'ALLOW' ? 'OK' : 'DENIED',
      decision: result.decision,
      decisionId: result.decisionId,
      receipt: result.receipt,
      error: result.error,
    };
  }

  private invalidArgs(base: { requestId: string; tool: string }, error: { issues: Array<{ path: Array<string | number>; message: string }> }): ProtocolResult {
    const message = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    return {
      requestId: base.requestId,
      tool: base.tool,
      status: 'ERROR',
      decision: null,
      data: null,
      error: { code: 'INVALID_TOOL_ARGS', message: `Tool arguments failed validation: ${message}` },
    };
  }

  private errorResult(base: { requestId: string; tool: string }, code: string, message: string): ProtocolResult {
    return { requestId: base.requestId, tool: base.tool, status: 'ERROR', decision: null, data: null, error: { code, message } };
  }

  private productsOf(data: unknown): ProductDTO[] {
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const products = (data as { products?: unknown }).products;
      if (Array.isArray(products)) {
        return products.filter((p): p is ProductDTO => typeof p === 'object' && p !== null);
      }
    }
    return [];
  }
}

export type { Decision };