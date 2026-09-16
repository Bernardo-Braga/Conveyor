import { openDb, type OpenedDb } from './db/index.ts';
import { env, dataPath } from './env.ts';
import { EventBus } from './events/bus.ts';
import { LedgerClient } from './http/ledgerClient.ts';
import { JobRegistry, type Services } from './jobs/types.ts';
import { JobWorker } from './jobs/worker.ts';
import { KeychainStore, MemoryStore, Secrets, type SecretStore } from './secrets/keychain.ts';
import { SettingsStore } from './settings/store.ts';
import { ShopifyTokenCache } from './shopify/token.ts';
import { connectionTestJob } from './connections/index.ts';
import { importJob } from './jobs/importJob.ts';
import { pullProductJob } from './jobs/pullProductJob.ts';
import { ShopifyClient } from './shopify/client.ts';
import { QuotaStore } from './suppliers/quota.ts';
import { RapidApiClient } from './suppliers/rapidapi.ts';

export interface AppContext extends Services {
  opened: OpenedDb;
  worker: JobWorker;
  registry: JobRegistry;
  shopifyTokens: ShopifyTokenCache;
  shopify: ShopifyClient;
  quota: QuotaStore;
  rapidapi: RapidApiClient;
  close(): Promise<void>;
}

export interface ContextOptions {
  dbFile?: string;
  secretStore?: SecretStore;
  fetchImpl?: typeof fetch;
}

/** Wires the server together. Tests pass `:memory:`, a MemoryStore and a fake fetch. */
export function createContext(opts: ContextOptions = {}): AppContext {
  const opened = openDb(opts.dbFile ?? dataPath('conveyor.sqlite'));
  const db = opened.db;
  const bus = new EventBus();
  const store = opts.secretStore ?? (env.secrets === 'memory' ? new MemoryStore() : new KeychainStore(env.keychainService));
  const secrets = new Secrets(store, db);
  const ledger = new LedgerClient({ db, bus, secretsForRedaction: () => secrets.allValues(), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const settings = new SettingsStore(db);
  const services: Services = { db, ledger, secrets, settings, bus };
  const shopifyTokens = new ShopifyTokenCache(ledger);
  const shopify = new ShopifyClient({ ledger, secrets, settings, tokens: shopifyTokens });
  const quota = new QuotaStore(db);
  const rapidapi = new RapidApiClient({ db, ledger, secrets, quota });
  const registry = new JobRegistry().register(connectionTestJob(shopifyTokens)).register(importJob({ rapidapi, quota })).register(pullProductJob({ shopify }));
  const worker = new JobWorker(services, registry);
  return {
    ...services,
    opened,
    worker,
    registry,
    shopifyTokens,
    shopify,
    quota,
    rapidapi,
    async close() {
      await worker.stop();
      opened.close();
    },
  };
}
