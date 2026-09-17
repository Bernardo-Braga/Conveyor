import type { ImportSettings, ListingDraft, Pricing, SourceProduct } from '@conveyor/shared';
import { JobStepError } from '../jobs/types.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { priceVariant } from './pricing.ts';

/** Above this many variants the draft is created asynchronously with widely spaced polls. */
export const SYNC_VARIANT_LIMIT = 100;
export const MAX_OPTIONS = 3;

/** Confirmed against Admin API 2026-07 with the Shopify schema tool on 16 September 2026. */
export const PRODUCT_SET = `
mutation ConveyorProductSet($input: ProductSetInput!, $synchronous: Boolean!, $identifier: ProductSetIdentifiers) {
  productSet(input: $input, synchronous: $synchronous, identifier: $identifier) {
    product { id handle title status updatedAt }
    productSetOperation { id status userErrors { field message code } }
    userErrors { field message code }
  }
}`;

export const PRODUCT_SET_OPERATION = `
query ConveyorProductSetOperation($id: ID!) {
  productOperation(id: $id) {
    ... on ProductSetOperation { id status product { id handle title status } userErrors { field message code } }
  }
}`;

export interface DraftPlan {
  input: Record<string, unknown>;
  synchronous: boolean;
  variantCount: number;
  imageCount: number;
  pricing: Pricing[];
  /** Why a variant or option was dropped or renamed, for the UI. */
  notes: string[];
}

const minorToMoney = (m: number) => (m / 100).toFixed(2);
const fileName = (url: string, i: number) => `${url.split('/').pop()?.split('?')[0]?.replace(/[^\w.-]/g, '') || `image-${i}.jpg`}`;

/**
 * Builds the productSet input from the listing, the source product and the pricing settings.
 * Everything here is local. Image URLs are passed as `originalSource` so Shopify fetches them.
 */
export function buildDraftInput(args: { source: SourceProduct; draft: ListingDraft; settings: ImportSettings; usdPerCny: number; sourceMeta: Record<string, unknown> }): DraftPlan {
  const { source, draft, settings, usdPerCny } = args;
  const notes: string[] = [];

  // Images in Claude's order, falling back to the source order. Description images only when asked.
  const order = draft.imageOrder.filter((i, idx, all) => i < source.images.length && all.indexOf(i) === idx);
  const gallery = (order.length ? order : source.images.map((_, i) => i)).map((i) => source.images[i]!);
  if (!order.length && draft.imageOrder.length) notes.push('Claude returned no valid image order; using the supplier order.');
  const urls = [...gallery, ...(settings.listing.includeDescriptionImages ? source.descriptionImages : [])].filter((u, i, all) => all.indexOf(u) === i);
  const files = urls.map((url, i) => ({ originalSource: url, contentType: 'IMAGE', alt: i === 0 ? draft.title : `${draft.title} ${i + 1}`, filename: fileName(url, i) }));

  const t = (name: string, map: Record<string, string>) => map[name]?.trim() || name;
  const options = source.options.slice(0, MAX_OPTIONS);
  if (source.options.length > MAX_OPTIONS) notes.push(`Shopify allows ${MAX_OPTIONS} options; ${source.options.length - MAX_OPTIONS} were dropped.`);
  const productOptions = options.map((o, i) => ({
    name: t(o.name, draft.optionNames),
    position: i + 1,
    values: uniqueBy(o.values.map((v) => ({ name: t(v.label, draft.optionValues) })), (v) => v.name),
  }));
  // Option value → image (from the supplier's swatch image), so variants get a picture.
  const valueImage = new Map<string, string>();
  for (const o of source.options) for (const v of o.values) if (v.image) valueImage.set(`${o.name}=${v.label}`, v.image);

  const pricing: Pricing[] = [];
  const seen = new Set<string>();
  const variants = source.variants
    .map((v) => {
      const optionValues = options.map((o, i) => ({ optionName: t(o.name, draft.optionNames), name: t(v.optionValues[i] ?? o.values[0]?.label ?? '', draft.optionValues) }));
      const key = optionValues.map((ov) => ov.name).join('|');
      if (seen.has(key)) return null; // dropped options can make duplicates
      seen.add(key);
      const p = priceVariant(v.costMinor, source.currency, settings.pricing, usdPerCny);
      pricing.push(p);
      const swatch = options.map((o, i) => valueImage.get(`${o.name}=${v.optionValues[i] ?? ''}`)).find(Boolean);
      const swatchClean = swatch ? urls.find((u) => u === swatch || u.endsWith(swatch.split('/').pop() ?? '')) : undefined;
      return {
        optionValues: options.length ? optionValues : [{ optionName: 'Title', name: 'Default Title' }],
        price: minorToMoney(p.priceMinor),
        compareAtPrice: minorToMoney(p.compareAtMinor),
        ...(v.skuId ? { sku: `${source.source.platform}-${source.source.itemId}-${v.skuId}` } : {}),
        inventoryPolicy: 'CONTINUE',
        inventoryItem: { tracked: false, cost: minorToMoney(p.landedCostMinor) },
        ...(swatchClean ? { file: { originalSource: swatchClean, contentType: 'IMAGE' } } : {}),
      };
    })
    .filter((v): v is NonNullable<typeof v> => !!v);
  if (variants.length < source.variants.length) notes.push(`${source.variants.length - variants.length} duplicate variant(s) were merged.`);
  if (!options.length && variants.length > 1) notes.push('No options; only the first variant is used.');

  const finalVariants = options.length ? variants : variants.slice(0, 1);
  const input = {
    title: draft.title,
    descriptionHtml: draft.descriptionHtml,
    status: 'DRAFT',
    productType: draft.productType,
    vendor: settings.listing.tag,
    tags: uniqueBy([settings.listing.tag, source.source.platform, ...draft.tags.map((x) => x.toLowerCase().trim())].filter(Boolean), (x) => x),
    seo: { title: draft.seo.title, description: draft.seo.description },
    files,
    ...(options.length ? { productOptions } : {}),
    variants: finalVariants,
    metafields: [
      { namespace: 'conveyor', key: 'source', type: 'json', value: JSON.stringify(args.sourceMeta) },
      { namespace: 'conveyor', key: 'highlights', type: 'json', value: JSON.stringify(draft.highlights) },
      ...(draft.needsCheck.length ? [{ namespace: 'conveyor', key: 'needs_check', type: 'json', value: JSON.stringify(draft.needsCheck) }] : []),
    ],
  };
  return { input, synchronous: finalVariants.length <= SYNC_VARIANT_LIMIT, variantCount: finalVariants.length, imageCount: files.length, pricing, notes };
}

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(key(i)) ? false : (seen.add(key(i)), true)));
}

interface ProductSetData {
  productSet: {
    product: { id: string; handle: string; title: string; status: string; updatedAt: string } | null;
    productSetOperation: { id: string; status: string; userErrors: UserError[] } | null;
    userErrors: UserError[];
  };
}
interface UserError {
  field: string[] | null;
  message: string;
  code: string | null;
}

export interface DraftCreated {
  id: string;
  handle: string;
  title: string;
  status: string;
  requests: number;
  requestId: string | null;
}

/**
 * One `productSet` request (plus widely spaced status polls in async mode).
 * `existingId` turns it into an update of the same product ("Rewrite a listing").
 */
export async function createDraft(client: ShopifyClient, plan: DraftPlan, meta: { productId: number | null; jobId: number | null; existingId?: string | null; sleep?: (ms: number) => Promise<void> }): Promise<DraftCreated> {
  const variables: Record<string, unknown> = { input: plan.input, synchronous: plan.synchronous };
  if (meta.existingId) variables.identifier = { id: meta.existingId };
  const { data, requestId } = await client.graphql<ProductSetData>('product_set', PRODUCT_SET, variables, meta);
  const errors = [...data.productSet.userErrors, ...(data.productSet.productSetOperation?.userErrors ?? [])];
  if (errors.length) throw userErrorsToStep(errors, requestId);
  let requests = 1;
  let product = data.productSet.product;
  if (!product && data.productSet.productSetOperation) {
    // Async: poll every 20 s, at most 15 times.
    const sleep = meta.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const opId = data.productSet.productSetOperation.id;
    for (let i = 0; i < 15 && !product; i++) {
      await sleep(20_000);
      const poll = await client.graphql<{ productOperation: { status: string; product: DraftCreated | null; userErrors: UserError[] } | null }>('product_set_poll', PRODUCT_SET_OPERATION, { id: opId }, meta);
      requests += 1;
      const op = poll.data.productOperation;
      if (op?.userErrors?.length) throw userErrorsToStep(op.userErrors, poll.requestId);
      if (op?.status === 'COMPLETE' && op.product) product = { ...op.product, updatedAt: '' };
    }
    if (!product) throw new JobStepError('Shopify is still creating the draft.', { service: 'shopify', requestId, suggestion: 'Retry this step in a minute; it only polls, it does not create a second product.', retryable: true });
  }
  if (!product) throw new JobStepError('Shopify returned no product.', { service: 'shopify', requestId, retryable: true });
  return { id: product.id, handle: product.handle, title: product.title, status: product.status, requests, requestId };
}

function userErrorsToStep(errors: UserError[], requestId: string | null): JobStepError {
  const first = errors[0]!;
  return new JobStepError(`Shopify rejected the draft: ${errors.map((e) => `${e.field?.join('.') ?? 'input'}: ${e.message}`).join('; ')}`, {
    service: 'shopify',
    code: first.code,
    requestId,
    suggestion: 'Nothing was created. Fix the listing (Rewrite listing) or the pricing settings and retry this step.',
    retryable: false,
  });
}
