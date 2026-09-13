// apps/api/src/app.ts
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { AppContext } from './appContext';
import { registerRoutes } from './routes';
import { DomainError } from './utils/errors';

/**
 * Determines allowed CORS origins.
 * - test:        any origin (integration tests spin up their own Fastify)
 * - production:  ALLOWED_ORIGIN env var + any *.vercel.app subdomain so the
 *                Vercel preview/production deployment works without extra config
 * - development: localhost only
 */
function getAllowedOrigins(ctx: AppContext): string[] | ((origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => void) {
  if (ctx.config.nodeEnv === 'test') return [];

  if (ctx.config.nodeEnv === 'production') {
    return (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      if (origin === undefined) { cb(null, true); return; }         // server-to-server / curl
      const allowedOrigin = process.env['ALLOWED_ORIGIN']?.trim();
      if (allowedOrigin && origin === allowedOrigin) { cb(null, true); return; }
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) { cb(null, true); return; }
      cb(null, false);
    };
  }

  // development
  return [
    `http://localhost:${ctx.config.webPort}`,
    `http://127.0.0.1:${ctx.config.webPort}`,
  ];
}

function statusForCode(code: string): number {
  if (code.includes('NOT_FOUND')) return 404;
  if (code.startsWith('INVALID')) return 400;
  // Every "an agent tried to do a human's job" refusal is a 403, not a 400.
  // CATALOG_MODIFICATION_BY_AGENT used to fall through to 400, so a client
  // distinguishing malformed input from forbidden action misread it.
  if (code.endsWith('_BY_AGENT')) return 403;
  if (
    code.startsWith('DECISION_') ||
    code.startsWith('EXECUTION_') ||
    code === 'CART_IMMUTABLE' ||
    code === 'CART_CHANGED_AT_EXECUTION' ||
    code === 'MANDATE_INVALID_AT_EXECUTION'
  ) {
    return 403;
  }
  // A missing merchant policy is a deployment failure, not a bad request.
  if (code === 'POLICY_MISSING' || code === 'EMPTY_CATALOG') return 500;
  if (code === 'IDEMPOTENCY_KEY_CONFLICT') return 409;
  return 400;
}

/**
 * Fastify app factory. Route handlers contain orchestration only; all domain
 * rules live in services. Errors are structured JSON — stack traces never
 * leave the server (§57, §66).
 */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.nodeEnv === 'test' ? false : { level: 'info' },
  });
  await app.register(cors, {
    origin: ctx.config.nodeEnv === 'test' ? true : getAllowedOrigins(ctx),
    credentials: true,
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body: string, done) => {
    if (typeof body === 'string' && body.trim().length === 0) {
      done(null, {});
      return;
    }
    try {
      const parsed = JSON.parse(body);
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      reply
        .status(statusForCode(error.code))
        .send({ error: { code: error.code, message: error.message, details: {} } });
      return;
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.', details: {} } });
      return;
    }
    reply.status(statusCode).send({ error: { code: 'HTTP_ERROR', message: error.message, details: {} } });
  });

  registerRoutes(app, ctx);
  return app;
}