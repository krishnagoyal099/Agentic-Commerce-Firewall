// apps/api/src/protocol/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOLS, ToolArgShapes } from './tools';
import type { MCPCommerceAdapter } from './MCPCommerceAdapter';
import { newId } from '../../utils/ids';

interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function agentIdOf(args: Record<string, unknown>): string {
  return typeof args.agentId === 'string' ? args.agentId : '';
}

function mandateIdOf(args: Record<string, unknown>): string | null {
  return typeof args.mandateId === 'string' ? args.mandateId : null;
}

async function call(adapter: MCPCommerceAdapter, tool: string, args: Record<string, unknown>): Promise<McpToolResponse> {
  const result = await adapter.invoke({
    requestId: newId('mcp'),
    agentId: agentIdOf(args),
    mandateId: mandateIdOf(args),
    tool,
    args,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: result.status !== 'OK',
  };
}

/**
 * Builds the MCP server over the shared adapter. Every tool call flows:
 * SDK-parsed args → adapter.invoke → ProtocolGateway → AuthorizationEngine →
 * domain services. No tool handler touches a payment provider directly (§35).
 */
export function createMcpServer(adapter: MCPCommerceAdapter): McpServer {
  const server = new McpServer({ name: 'agentic-commerce-firewall', version: '1.0.0' });

  server.registerTool('search_products', { title: MCP_TOOLS[0]!.title, description: MCP_TOOLS[0]!.description, inputSchema: ToolArgShapes.search_products }, async (args) => call(adapter, 'search_products', args as Record<string, unknown>));
  server.registerTool('get_product', { title: MCP_TOOLS[1]!.title, description: MCP_TOOLS[1]!.description, inputSchema: ToolArgShapes.get_product }, async (args) => call(adapter, 'get_product', args as Record<string, unknown>));
  server.registerTool('create_cart', { title: MCP_TOOLS[2]!.title, description: MCP_TOOLS[2]!.description, inputSchema: ToolArgShapes.create_cart }, async (args) => call(adapter, 'create_cart', args as Record<string, unknown>));
  server.registerTool('get_cart', { title: MCP_TOOLS[3]!.title, description: MCP_TOOLS[3]!.description, inputSchema: ToolArgShapes.get_cart }, async (args) => call(adapter, 'get_cart', args as Record<string, unknown>));
  server.registerTool('add_cart_item', { title: MCP_TOOLS[4]!.title, description: MCP_TOOLS[4]!.description, inputSchema: ToolArgShapes.add_cart_item }, async (args) => call(adapter, 'add_cart_item', args as Record<string, unknown>));
  server.registerTool('propose_purchase', { title: MCP_TOOLS[5]!.title, description: MCP_TOOLS[5]!.description, inputSchema: ToolArgShapes.propose_purchase }, async (args) => call(adapter, 'propose_purchase', args as Record<string, unknown>));
  server.registerTool('request_authorization', { title: MCP_TOOLS[6]!.title, description: MCP_TOOLS[6]!.description, inputSchema: ToolArgShapes.request_authorization }, async (args) => call(adapter, 'request_authorization', args as Record<string, unknown>));
  server.registerTool('get_decision_receipt', { title: MCP_TOOLS[7]!.title, description: MCP_TOOLS[7]!.description, inputSchema: ToolArgShapes.get_decision_receipt }, async (args) => call(adapter, 'get_decision_receipt', args as Record<string, unknown>));
  server.registerTool('create_payment', { title: MCP_TOOLS[8]!.title, description: MCP_TOOLS[8]!.description, inputSchema: ToolArgShapes.create_payment }, async (args) => call(adapter, 'create_payment', args as Record<string, unknown>));
  server.registerTool('get_payment_status', { title: MCP_TOOLS[9]!.title, description: MCP_TOOLS[9]!.description, inputSchema: ToolArgShapes.get_payment_status }, async (args) => call(adapter, 'get_payment_status', args as Record<string, unknown>));

  return server;
}