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
import { listingJob } from './jobs/listingJob.ts';
import { ShopifyClient } from './shopify/client.ts';
import { QuotaStore } from './suppliers/quota.ts';
import { RapidApiClient } from './suppliers/rapidapi.ts';
import { makeWriters, type RunCli, type WriterSet } from './listing/writers/index.ts';
import { codexEngine } from './images/codexWorkers.ts';
import { openaiEngine } from './images/openaiEngine.ts';
import type { EngineSet } from './images/engine.ts';
import { shopifyMediaJob } from './jobs/shopifyMediaJob.ts';
import { generateBatchJob } from './jobs/generateBatchJob.ts';
import { importShopifyPhotosJob } from './jobs/importShopifyPhotosJob.ts';
import { MetaClient } from './meta/client.ts';
import { activateJob, applyEditsJob, findInterestsJob, launchJob, pullInsightsJob, readCampaignJob, validateInterestsJob } from './jobs/metaJobs.ts';
import type { ImageSettings } from '@conveyor/shared';

export interface AppContext extends Services {
  opened: OpenedDb;
  worker: JobWorker;
  registry: JobRegistry;
  shopifyTokens: ShopifyTokenCache;
  shopify: ShopifyClient;
  quota: QuotaStore;
  rapidapi: RapidApiClient;
  writers: WriterSet;
  meta: MetaClient;
  /** Set in tests: the fake CLI runner, so import-mapping proposals never start a subprocess. */
  writerRun: RunCli | null;
  dataDir: string;
  close(): Promise<void>;
}

export interface ContextOptions {
  dbFile?: string;
  secretStore?: SecretStore;
  fetchImpl?: typeof fetch;
  /** Tests inject a fake CLI runner so no Claude Code or Codex subprocess starts. */
  runCli?: RunCli;
  dataDir?: string;
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
  const writers = makeWriters({ ledger, secrets, ...(opts.runCli ? { run: opts.runCli } : {}) });
  const services: Services = { db, ledger, secrets, settings, bus, writers, dataDir: opts.dataDir ?? env.dataDir };
  const shopifyTokens = new ShopifyTokenCache(ledger);
  const shopify = new ShopifyClient({ ledger, secrets, settings, tokens: shopifyTokens });
  const quota = new QuotaStore(db);
  const rapidapi = new RapidApiClient({ db, ledger, secrets, quota });
  /** Engines are built per batch from the image settings; tests inject the same fake CLI runner. */
  const engines = (img: ImageSettings): EngineSet => ({
    codex: codexEngine({ workers: img.codex.workers, imagesPerTask: img.codex.imagesPerTask, timeLimitPerImageMs: img.codex.timeLimitPerImageSec * 1000, db, ...(opts.runCli ? { run: opts.runCli, pollMs: 20 } : {}) }),
    openai: openaiEngine({ ledger, secrets, db, settings: img.openai }),
  });
  const registry = new JobRegistry()
    .register(connectionTestJob(shopifyTokens))
    .register(pullProductJob({ shopify }))
    .register(listingJob({ shopify, writers }))
    .register(generateBatchJob({ shopify, engines }))
    .register(shopifyMediaJob({ shopify }))
    .register(importShopifyPhotosJob({ shopify }));
  const meta = new MetaClient({ ledger, secrets });
  registry.register(launchJob({ meta, shopify })).register(activateJob({ meta })).register(findInterestsJob({ meta })).register(validateInterestsJob({ meta })).register(pullInsightsJob({ meta })).register(readCampaignJob({ meta })).register(applyEditsJob({ meta }));
  const worker = new JobWorker(services, registry);
  // The import job chains into the listing job (a pasted link becomes a draft in 3 requests).
  registry.register(importJob({ rapidapi, quota, enqueue: (type, input, productId) => worker.enqueue(type, input, productId) }));
  return {
    ...services,
    opened,
    worker,
    registry,
    shopifyTokens,
    shopify,
    quota,
    rapidapi,
    writers,
    meta,
    writerRun: opts.runCli ?? null,
    async close() {
      await worker.stop();
      opened.close();
    },
  };
}
