// apps/api/src/context.ts  (MODIFIED — full reprint; fixes the bogus shared AppConfig import)
import { ACTOR_IDS } from '@acsf/shared';
import type { AppConfig } from './config';
import type { DatabaseHandle } from './db/client';
import { MockPaymentProvider } from './providers/MockPaymentProvider';
import { RazorpayPaymentProvider } from './providers/RazorpayPaymentProvider';
import type { PaymentProvider } from './providers/PaymentProvider';
import { AuthorityDriftEngine } from './services/AuthorityDriftEngine';
import { AuditService } from './services/AuditService';
import { AuthorizationEngine } from './services/AuthorizationEngine';
import { CapabilityService } from './services/CapabilityService';
import { CartIntegrityService } from './services/CartIntegrityService';
import { CartService } from './services/CartService';
import { CatalogAdminService } from './services/CatalogAdminService';
import { CatalogService } from './services/CatalogService';
import { MandateService } from './services/MandateService';
import { PaymentReconciliationService } from './services/PaymentReconciliationService';
import { PaymentService } from './services/PaymentService';
import { PolicyEngine } from './services/PolicyEngine';
import type { Clock } from './utils/clock';

export interface ServiceContext {
  db: DatabaseHandle['db'];
  sqlite: DatabaseHandle['sqlite'];
  clock: Clock;
  config: AppConfig;
  merchantId: string;
  catalog: CatalogService;
  catalogAdmin: CatalogAdminService;
  audit: AuditService;
  mandates: MandateService;
  capabilities: CapabilityService;
  policies: PolicyEngine;
  cartIntegrity: CartIntegrityService;
  drift: AuthorityDriftEngine;
  carts: CartService;
  authorization: AuthorizationEngine;
  provider: PaymentProvider;
  payments: PaymentService;
  reconciliation: PaymentReconciliationService;
}

/** Provider selection (§26): mock by default; Razorpay only when fully configured. */
export function buildPaymentProvider(config: AppConfig, clock: Clock): PaymentProvider {
  if (
    config.paymentProvider === 'razorpay' &&
    config.razorpayKeyId !== null &&
    config.razorpayKeySecret !== null
  ) {
    return new RazorpayPaymentProvider(config.razorpayKeyId, config.razorpayKeySecret);
  }
  return new MockPaymentProvider(clock);
}

/**
 * Single wiring point for the domain. Dependency graph (acyclic):
 * catalog, audit → mandates, capabilities, policies → cartIntegrity, drift →
 * carts → authorization → provider, payments → reconciliation.
 */
export function buildServiceContext(
  handle: DatabaseHandle,
  clock: Clock,
  config: AppConfig,
): ServiceContext {
  const db = handle.db;
  const audit = new AuditService(db, clock);
  const catalog = new CatalogService(db);
  const catalogAdmin = new CatalogAdminService(db, clock, audit, ACTOR_IDS.merchantId);
  const mandates = new MandateService(db, clock, audit);
  const capabilities = new CapabilityService(db);
  const policies = new PolicyEngine(db, clock, audit);
  const cartIntegrity = new CartIntegrityService(db);
  const drift = new AuthorityDriftEngine(db, clock);
  const carts = new CartService(db, clock, audit, drift, cartIntegrity);
  const authorization = new AuthorizationEngine(
    db,
    clock,
    ACTOR_IDS.merchantId,
    catalog,
    audit,
    mandates,
    capabilities,
    policies,
    cartIntegrity,
    carts,
    drift,
  );
  const provider = buildPaymentProvider(config, clock);
  const payments = new PaymentService(
    db,
    clock,
    audit,
    provider,
    ACTOR_IDS.merchantId,
    carts,
    cartIntegrity,
    mandates,
    policies,
  );
  const reconciliation = new PaymentReconciliationService(db, clock, audit, provider, payments, carts);
  return {
    db,
    sqlite: handle.sqlite,
    clock,
    config,
    merchantId: ACTOR_IDS.merchantId,
    catalog,
    catalogAdmin,
    audit,
    mandates,
    capabilities,
    policies,
    cartIntegrity,
    drift,
    carts,
    authorization,
    provider,
    payments,
    reconciliation,
  };
}