/**
 * Drizzle schema. Money is in minor units as integers.
 * Times are ISO-8601 text. JSON columns are validated with Zod at the boundary.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = () => new Date().toISOString();
const createdAt = () => text('created_at').notNull().$defaultFn(now);
const updatedAt = () => text('updated_at').notNull().$defaultFn(now);

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    origin: text('origin', { enum: ['link', 'shopify'] }).notNull(),
    platform: text('platform', { enum: ['aliexpress', '1688'] }),
    itemId: text('item_id'),
    sourceUrl: text('source_url'),
    state: text('state').notNull().default('importing'),
    title: text('title'),
    moq: integer('moq'),
    /** A line or two of direction for this product's listing, typed in the input bar. */
    focus: text('focus').notNull().default(''),
    failure: text('failure', { mode: 'json' }),
    /** The normalised SourceProduct, mapped from the latest raw supplier response. */
    source: text('source', { mode: 'json' }),
    sourceRawId: integer('source_raw_id'),
    listingDraft: text('listing_draft', { mode: 'json' }),
    shopifyProductId: text('shopify_product_id'),
    shopifyHandle: text('shopify_handle'),
    snapshot: text('snapshot', { mode: 'json' }),
    snapshotAt: text('snapshot_at'),
    highlights: text('highlights', { mode: 'json' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_platform_item_unique').on(t.platform, t.itemId),
    index('products_shopify_id_idx').on(t.shopifyProductId),
    index('products_state_idx').on(t.state),
  ],
);

export const supplierRaw = sqliteTable(
  'supplier_raw',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    platform: text('platform', { enum: ['aliexpress', '1688'] }).notNull(),
    itemId: text('item_id').notNull(),
    fetchedAt: text('fetched_at').notNull().$defaultFn(now),
    httpStatus: integer('http_status').notNull(),
    body: text('body').notNull(),
  },
  (t) => [index('supplier_raw_item_idx').on(t.platform, t.itemId)],
);

export const productCopy = sqliteTable('product_copy', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: integer('product_id').notNull().references(() => products.id),
  bodyText: text('body_text').notNull(),
  headline: text('headline').notNull(),
  description: text('description'),
  sourceTemplateId: text('source_template_id'),
  createdAt: createdAt(),
});

/** The request ledger. Never headers, never bodies, never a query string. */
export const requests = sqliteTable(
  'requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull().$defaultFn(now),
    service: text('service').notNull(),
    purpose: text('purpose').notNull(),
    productId: integer('product_id'),
    jobId: integer('job_id'),
    method: text('method').notNull(),
    url: text('url').notNull(),
    status: integer('status'),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    quotaRemaining: integer('quota_remaining'),
    quotaResetAt: text('quota_reset_at'),
    requestId: text('request_id'),
    error: text('error'),
  },
  (t) => [index('requests_at_idx').on(t.at), index('requests_service_idx').on(t.service), index('requests_product_idx').on(t.productId)],
);

export const costs = sqliteTable('costs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id'),
  service: text('service').notNull(),
  units: text('units', { mode: 'json' }),
  amountMinor: integer('amount_minor').notNull().default(0),
  currency: text('currency').notNull().default('USD'),
  createdAt: createdAt(),
});

export const settings = sqliteTable('settings', {
  section: text('section').primaryKey(),
  json: text('json', { mode: 'json' }).notNull(),
  updatedAt: updatedAt(),
});

/** Only metadata. The value itself lives in the Keychain and is never written here. */
export const secretMeta = sqliteTable('secret_meta', {
  name: text('name').primaryKey(),
  updatedAt: updatedAt(),
});

export const connectionChecks = sqliteTable('connection_checks', {
  service: text('service').primaryKey(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  detail: text('detail').notNull(),
  checkedAt: text('checked_at').notNull(),
  requestId: text('request_id'),
  requests: integer('requests').notNull().default(0),
});

export const promptTemplates = sqliteTable('prompt_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  body: text('body').notNull(),
  variables: text('variables', { mode: 'json' }).notNull(),
  formats: text('formats', { mode: 'json' }).notNull(),
  countPerFormat: integer('count_per_format').notNull().default(4),
  referenceRule: text('reference_rule').notNull().default('first_3_shopify_images'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

export const templates = sqliteTable(
  'templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    templateId: text('template_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    source: text('source').notNull(),
    json: text('json', { mode: 'json' }).notNull(),
    /** The JSON file under the data directory's templates/ folder this row mirrors. */
    filePath: text('file_path'),
    fileMtime: text('file_mtime'),
    fileMissing: integer('file_missing', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('templates_template_id_unique').on(t.templateId)],
);

export const importProfiles = sqliteTable(
  'import_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signature: text('signature').notNull(),
    mapping: text('mapping', { mode: 'json' }).notNull(),
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('import_profiles_signature_unique').on(t.signature)],
);

export const interestCache = sqliteTable('interest_cache', {
  label: text('label').primaryKey(),
  metaId: text('meta_id'),
  metaName: text('meta_name'),
  suggestions: text('suggestions', { mode: 'json' }),
  userPick: text('user_pick', { mode: 'json' }),
  lastCheckedAt: text('last_checked_at'),
});

export const referenceCache = sqliteTable(
  'reference_cache',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id').notNull().references(() => products.id),
    shopifyImageId: text('shopify_image_id').notNull(),
    path: text('path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('reference_cache_unique').on(t.productId, t.shopifyImageId)],
);

export const creativeBatches = sqliteTable('creative_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: integer('product_id').notNull().references(() => products.id),
  promptTemplateId: integer('prompt_template_id'),
  promptTemplateVersion: integer('prompt_template_version'),
  /** The exact prompt sent, after variables were filled. */
  prompt: text('prompt').notNull(),
  engine: text('engine', { enum: ['codex', 'openai', 'shopify'] }).notNull(),
  status: text('status').notNull().default('queued'),
  handle: text('handle'),
  formats: text('formats', { mode: 'json' }).notNull().default('[]'),
  countPerFormat: integer('count_per_format').notNull().default(0),
  /** Copy of the image settings this batch ran with. */
  settingsUsed: text('settings_used', { mode: 'json' }),
  apiRequests: integer('api_requests').notNull().default(0),
  costMinor: integer('cost_minor'),
  taskCount: integer('task_count'),
  note: text('note'),
  replacesCreativeId: integer('replaces_creative_id'),
  createdAt: createdAt(),
  finishedAt: text('finished_at'),
});

/** One planned image. Rows are created up front so a retry generates only what is missing. */
export const creatives = sqliteTable(
  'creatives',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id').notNull().references(() => creativeBatches.id),
    productId: integer('product_id').notNull().references(() => products.id),
    aspect: text('aspect', { enum: ['1:1', '4:5', '9:16'] }).notNull(),
    /** Product-wide number per aspect; the NN in `{handle}_{4x5}_{NN}.jpg`. */
    slot: integer('slot').notNull(),
    status: text('status', { enum: ['pending', 'generating', 'finished', 'failed'] }).notNull().default('pending'),
    originalPath: text('original_path'),
    detectedFormat: text('detected_format'),
    finishedPath: text('finished_path'),
    fileName: text('file_name'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    sha256: text('sha256'),
    metadataCheck: text('metadata_check'),
    approval: text('approval', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
    flags: text('flags', { mode: 'json' }),
    error: text('error'),
    metaImageHash: text('meta_image_hash'),
    /** Shopify MediaImage gid once the finished file is on the product. */
    shopifyMediaId: text('shopify_media_id'),
    /** Set when this creative was imported FROM a Shopify photo: the MediaImage it came from. */
    sourceMediaId: text('source_media_id'),
    createdAt: createdAt(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('creatives_batch_idx').on(t.batchId), index('creatives_product_idx').on(t.productId), uniqueIndex('creatives_product_aspect_slot').on(t.productId, t.aspect, t.slot), uniqueIndex('creatives_product_source_media').on(t.productId, t.sourceMediaId)],
);

export const codexTasks = sqliteTable('codex_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull().references(() => creativeBatches.id),
  creativeIds: text('creative_ids', { mode: 'json' }),
  aspect: text('aspect'),
  worker: integer('worker'),
  folder: text('folder').notNull(),
  attempts: integer('attempts').notNull().default(0),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  /** Which slots the task produced, and how long it took. */
  result: text('result', { mode: 'json' }),
  error: text('error'),
});

/**
 * The launch plan for one product: the template copy it is launched with, and the creatives
 * chosen for it. Editing here never touches the template file.
 */
export const productLaunch = sqliteTable(
  'product_launch',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id').notNull().references(() => products.id),
    /** The `templates` row this copy was taken from. */
    templateId: integer('template_id').notNull(),
    /** The template as edited for this product; null while it follows the template file. */
    template: text('template', { mode: 'json' }),
    /** Creative IDs chosen for the launch, in the order they fill the ads; null means every approved one. */
    creativeIds: text('creative_ids', { mode: 'json' }),
    /** This launch's own campaign name, schedule, targeting and budget (`LaunchOverrides`). */
    overrides: text('overrides', { mode: 'json' }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('product_launch_product_unique').on(t.productId)],
);

export const campaigns = sqliteTable('campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  productId: integer('product_id').notNull().references(() => products.id),
  templateJson: text('template_json', { mode: 'json' }).notNull(),
  metaCampaignId: text('meta_campaign_id'),
  status: text('status').notNull().default('draft'),
  lastReadAt: text('last_read_at'),
  lastState: text('last_state', { mode: 'json' }),
  createdAt: createdAt(),
});

export const adSets = sqliteTable('ad_sets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull().references(() => campaigns.id),
  name: text('name').notNull(),
  budgetMinor: integer('budget_minor'),
  overrides: text('overrides', { mode: 'json' }),
  interests: text('interests', { mode: 'json' }),
  interestSource: text('interest_source', { enum: ['file', 'name', 'pick', 'none'] }).notNull().default('none'),
  metaId: text('meta_id'),
  status: text('status').notNull().default('PAUSED'),
});

export const ads = sqliteTable('ads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  adSetId: integer('ad_set_id').notNull().references(() => adSets.id),
  creativeId: integer('creative_id').references(() => creatives.id),
  copyId: integer('copy_id').references(() => productCopy.id),
  metaCreativeId: text('meta_creative_id'),
  metaAdId: text('meta_ad_id'),
  status: text('status').notNull().default('PAUSED'),
  insights: text('insights', { mode: 'json' }),
});

export const campaignEdits = sqliteTable('campaign_edits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull().references(() => campaigns.id),
  changes: text('changes', { mode: 'json' }).notNull(),
  stateBefore: text('state_before', { mode: 'json' }),
  batchResults: text('batch_results', { mode: 'json' }),
  createdAt: createdAt(),
});

/** Jobs are ordered lists of named, idempotent steps with a checkpoint after each. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    productId: integer('product_id'),
    status: text('status').notNull().default('queued'),
    input: text('input', { mode: 'json' }),
    steps: text('steps', { mode: 'json' }).notNull(),
    currentStep: text('current_step'),
    /** step name → saved result. A retry skips steps that already have one. */
    checkpoints: text('checkpoints', { mode: 'json' }).notNull().default('{}'),
    attempts: integer('attempts').notNull().default(0),
    progress: text('progress', { mode: 'json' }),
    error: text('error', { mode: 'json' }),
    log: text('log', { mode: 'json' }).notNull().default('[]'),
    createdAt: createdAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    updatedAt: updatedAt(),
  },
  (t) => [index('jobs_status_idx').on(t.status), index('jobs_product_idx').on(t.productId)],
);

/** Last known RapidAPI quota per platform, from response headers only. Never a quota call. */
export const supplierQuota = sqliteTable('supplier_quota', {
  platform: text('platform', { enum: ['aliexpress', '1688'] }).primaryKey(),
  remaining: integer('remaining'),
  resetAt: text('reset_at'),
  updatedAt: updatedAt(),
});
