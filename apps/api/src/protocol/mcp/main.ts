// apps/api/src/protocol/mcp/main.ts  (MODIFIED — full reprint; awaits the async bootstrap)
/**
 * Standalone MCP server entry — `npm run mcp` (§56).
 * Uses the same SQLite database, domain services, gateway, and AuthorizationEngine
 * as the REST API. Stdout is the JSON-RPC channel, so ALL logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../../config';
import { buildAppContext } from '../../appContext';
import { buildServiceContext } from '../../context';
import { createDatabase } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { seedDatabase } from '../../db/seed';
import { SystemClock } from '../../utils/clock';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDatabase(config.databaseUrl);
  runMigrations(handle.sqlite);
  const clock = new SystemClock();
  seedDatabase(handle.db, clock);
  const ctx = buildAppContext(buildServiceContext(handle, clock, config), handle);
  await ctx.demo.ensureBootstrapped();
  const server = createMcpServer(ctx.adapter);
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] Agentic Commerce Firewall MCP server on stdio (db=${config.databaseUrl}, provider=${ctx.provider.name}).`);
  console.error('[mcp] Safe tools: search_products, get_product, create_cart, get_cart, add_cart_item, propose_purchase, request_authorization, get_decision_receipt, create_payment, get_payment_status');
  console.error('[mcp] Privileged tools (refund, policy, mandate, payout, settlement) are NOT exposed; unknown tools are denied at this boundary.');
}

main().catch((err: unknown) => {
  console.error('[mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});