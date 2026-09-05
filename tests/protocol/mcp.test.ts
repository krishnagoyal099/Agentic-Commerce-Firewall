// tests/protocol/mcp.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOL_NAMES } from '@acsf/shared';
import { createMcpServer } from '../../apps/api/src/protocol/mcp/server';
import { createCart, createStandardMandate, createTestApp, type TestApp } from '../helpers/testApp';

let t: TestApp;

beforeEach(() => {
  t = createTestApp();
});

afterEach(() => {
  t.close();
});

function invocation(tool: string, args: Record<string, unknown>, mandateId: string | null) {
  return t.ctx.adapter.invoke({
    requestId: `mcp-test-${tool}`,
    agentId: 'buyer-agent-01',
    mandateId,
    tool,
    args,
  });
}

describe('MCP ingress (§4, §35, §69 protocol list)', () => {
  it('exposes exactly the ten safe tools and no privileged surface', () => {
    const tools = t.ctx.adapter.listTools().map((tool) => tool.name).sort();
    expect(tools).toEqual([...MCP_TOOL_NAMES].sort());
    const forbidden = ['refund', 'modify_policy', 'modify_mandate', 'merchant_payout', 'settlement_account'];
    expect(tools.filter((name) => forbidden.includes(name))).toHaveLength(0);
  });

  it('a valid MCP search succeeds', async () => {
    const result = await invocation('search_products', { agentId: 'buyer-agent-01', query: 'running' }, null);
    expect(result.status).toBe('OK');
    const products = (result.data as { products?: unknown[] }).products ?? [];
    expect(products.length).toBeGreaterThan(0);
  });

  it('a valid MCP cart succeeds through the AuthorizationEngine', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const decisionsBefore = t.ctx.authorization.listDecisions({ limit: 200 }).length;
    const result = await invocation(
      'create_cart',
      { agentId: 'buyer-agent-01', mandateId, items: [{ productId: 'shoe-001', quantity: 1 }] },
      mandateId,
    );
    expect(result.status).toBe('OK');
    expect(result.decision).toBe('ALLOW');
    const cart = result.data as { id: string };
    expect(t.ctx.carts.getCart(cart.id)).not.toBeNull();
    expect(t.ctx.authorization.listDecisions({ limit: 200 }).length).toBe(decisionsBefore + 1);
  });

  it('invalid tool arguments return a structured error', async () => {
    const result = await invocation('create_cart', { agentId: 'buyer-agent-01' }, null);
    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('INVALID_TOOL_ARGS');
  });

  it('an unexposed privileged tool (refund) is denied at the boundary', async () => {
    const result = await invocation(
      'refund',
      { agentId: 'buyer-agent-01', paymentId: 'pay_x', amountPaise: 100_000 },
      null,
    );
    expect(result.status).toBe('DENIED');
    expect(result.error?.code).toBe('TOOL_NOT_EXPOSED');
    const own = t.ctx.gateway.listProtocolRequests(50).find((r) => r.id === result.requestId);
    expect(own?.status).toBe('DENIED');
  });

  it('MCP payment is firewall-gated (claimed amount must match the cart)', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const created = await invocation(
      'create_cart',
      { agentId: 'buyer-agent-01', mandateId, items: [{ productId: 'shoe-001', quantity: 1 }] },
      mandateId,
    );
    const cart = created.data as { id: string };
    const payment = await invocation(
      'create_payment',
      { agentId: 'buyer-agent-01', mandateId, cartId: cart.id, amountPaise: 1, discountPaise: 0 },
      mandateId,
    );
    expect(payment.decision).toBe('BLOCK');
    expect(t.ctx.payments.listPayments(10)).toHaveLength(0);
  });

  it('get_decision_receipt returns the human-readable receipt', async () => {
    const mandateId = createStandardMandate(t.ctx);
    const cart = await createCart(t.ctx, 'buyer-agent-01', mandateId, [{ productId: 'shoe-001', quantity: 1 }]);
    const decision = t.ctx.authorization
      .listDecisions({ limit: 200 })
      .find((d) => d.cartId === cart.id && d.actionType === 'cart.create');
    expect(decision).toBeDefined();
    const result = await invocation('get_decision_receipt', { agentId: 'buyer-agent-01', decisionId: decision?.id ?? '' }, mandateId);
    expect(result.status).toBe('OK');
    const text = (result.data as { text?: string }).text ?? '';
    expect(text).toContain('AUTHORIZATION RECEIPT');
  });

  it('a real MCP client round-trip over the in-memory transport', async () => {
    const server = createMcpServer(t.ctx.adapter);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'acf-test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.length).toBe(10);

      const mandateId = createStandardMandate(t.ctx);
      const called = await client.callTool({
        name: 'create_cart',
        arguments: { agentId: 'buyer-agent-01', mandateId, items: [{ productId: 'shoe-001', quantity: 1 }] },
      });
      const content = called.content as Array<{ type: string; text?: string }>;
      const parsed = JSON.parse(content[0]?.text ?? '{}') as { status?: string; data?: { id?: string } };
      expect(parsed.status).toBe('OK');
      expect(parsed.data?.id).toBeDefined();

      const searched = await client.callTool({
        name: 'search_products',
        arguments: { agentId: 'buyer-agent-01', query: 'socks' },
      });
      const searchContent = searched.content as Array<{ type: string; text?: string }>;
      const searchParsed = JSON.parse(searchContent[0]?.text ?? '{}') as { status?: string };
      expect(searchParsed.status).toBe('OK');
    } finally {
      await client.close();
      await server.close();
    }
  });
});