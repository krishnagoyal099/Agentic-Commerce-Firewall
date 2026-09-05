// apps/api/src/config.ts
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  DATABASE_URL: z.string().min(1).default('./data/firewall.db'),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  LLM_PROVIDER: z.enum(['deterministic', 'external']).default('deterministic'),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  LLM_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
  // Tried in order when the configured model is not available to the key.
  LLM_MODEL_FALLBACKS: z
    .string()
    .default('llama-3.1-8b-instant,openai/gpt-oss-120b,llama-3.3-70b-versatile'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
});

export type EnvSource = Record<string, string | undefined>;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  apiPort: number;
  webPort: number;
  databaseUrl: string;
  paymentProvider: 'mock' | 'razorpay';
  razorpayKeyId: string | null;
  razorpayKeySecret: string | null;
  paymentProviderWarning: string | null;
  llmProvider: 'deterministic' | 'external';
  llmApiKey: string | null;
  llmBaseUrl: string;
  llmModel: string;
  /** Ordered alternatives tried when llmModel is refused by the provider. */
  llmModelFallbacks: string[];
  llmTimeoutMs: number;
  /** True only when an external LLM is both selected AND credentialed. */
  llmEnabled: boolean;
  llmWarning: string | null;
  mcpPort: number;
}

/**
 * Loads and validates environment configuration. Razorpay is enabled ONLY when
 * PAYMENT_PROVIDER=razorpay AND both credentials are present; otherwise the
 * app silently and safely runs on the mock provider (§26).
 */
export function loadConfig(env: EnvSource = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const e = parsed.data;
  const razorpayKeyId = e.RAZORPAY_KEY_ID?.trim() || null;
  const razorpayKeySecret = e.RAZORPAY_KEY_SECRET?.trim() || null;
  const razorpayConfigured = razorpayKeyId !== null && razorpayKeySecret !== null;

  let paymentProvider: 'mock' | 'razorpay' = 'mock';
  let paymentProviderWarning: string | null = null;
  if (e.PAYMENT_PROVIDER === 'razorpay') {
    if (razorpayConfigured) {
      paymentProvider = 'razorpay';
    } else {
      paymentProviderWarning =
        'PAYMENT_PROVIDER=razorpay but RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured; falling back to the mock payment provider.';
    }
  }

  const llmApiKey = e.LLM_API_KEY?.trim() || null;
  let llmWarning: string | null = null;
  if (e.LLM_PROVIDER === 'external' && llmApiKey === null) {
    llmWarning =
      'LLM_PROVIDER=external but LLM_API_KEY is not set; intent planning falls back to the deterministic parser.';
  }
  const llmEnabled = e.LLM_PROVIDER === 'external' && llmApiKey !== null;

  return {
    nodeEnv: e.NODE_ENV,
    apiPort: e.API_PORT,
    webPort: e.WEB_PORT,
    databaseUrl: e.DATABASE_URL,
    paymentProvider,
    razorpayKeyId,
    razorpayKeySecret,
    paymentProviderWarning,
    llmProvider: e.LLM_PROVIDER,
    llmApiKey,
    llmBaseUrl: e.LLM_BASE_URL,
    llmModel: e.LLM_MODEL,
    llmModelFallbacks: e.LLM_MODEL_FALLBACKS.split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== e.LLM_MODEL),
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    llmEnabled,
    llmWarning,
    mcpPort: e.MCP_PORT,
  };
}