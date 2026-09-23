import fs from 'node:fs/promises';
import path from 'node:path';
import type { LedgerClient } from '../http/ledgerClient.ts';
import { JobStepError } from '../jobs/types.ts';
import type { ShopifyClient } from './client.ts';

/**
 * Putting a local file on a Shopify product takes three kinds of request:
 * 1. `stagedUploadsCreate`: one Admin mutation for the whole set, returning a signed target per file.
 * 2. One POST per file to that target (Shopify's upload bucket, not the Admin API, so no throttle cost).
 * 3. `productCreateMedia`: one Admin mutation attaching every uploaded file by its `resourceUrl`.
 * Needs the `write_files` and `write_products` scopes.
 */
export const STAGED_UPLOADS_MUTATION = `
mutation ConveyorStagedUploads($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

export const PRODUCT_CREATE_MEDIA_MUTATION = `
mutation ConveyorProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
  productCreateMedia(productId: $productId, media: $media) {
    media { id alt status ... on MediaImage { image { url } } }
    mediaUserErrors { code field message }
  }
}`;

export interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

export interface StagedFile {
  filename: string;
  path: string;
  bytes: number;
}

type Meta = { productId?: number | null; jobId?: number | null };

/** One Admin request for any number of files. */
export async function stageUploads(client: ShopifyClient, files: StagedFile[], meta: Meta): Promise<{ targets: StagedTarget[]; requestId: string | null }> {
  const input = files.map((f) => ({ resource: 'IMAGE', filename: f.filename, mimeType: 'image/jpeg', httpMethod: 'POST', fileSize: String(f.bytes) }));
  const res = await client.graphql<{ stagedUploadsCreate: { stagedTargets: StagedTarget[] | null; userErrors: { field: string[] | null; message: string }[] } }>('staged_uploads', STAGED_UPLOADS_MUTATION, { input }, meta);
  const out = res.data.stagedUploadsCreate;
  if (out.userErrors.length) {
    throw new JobStepError(`Shopify refused the upload request: ${out.userErrors.map((e) => e.message).join('; ')}`, { service: 'shopify', code: 'STAGED_UPLOAD', requestId: res.requestId, suggestion: 'Check that the app has the write_files scope.' });
  }
  const targets = out.stagedTargets ?? [];
  if (targets.length !== files.length) throw new JobStepError(`Shopify returned ${targets.length} upload targets for ${files.length} files.`, { service: 'shopify', requestId: res.requestId, retryable: true });
  return { targets, requestId: res.requestId };
}

/** One POST per file to the signed target. Shopify's parameters go first, the file last. */
export async function uploadStaged(ledger: LedgerClient, file: StagedFile, target: StagedTarget, meta: Meta): Promise<void> {
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  const data = await fs.readFile(file.path);
  form.append('file', new Blob([new Uint8Array(data)], { type: 'image/jpeg' }), file.filename);
  const res = await ledger.fetch({ service: 'cdn', purpose: 'shopify_staged_upload', productId: meta.productId ?? null, jobId: meta.jobId ?? null }, target.url, { method: 'POST', body: form }, { timeoutMs: 120_000, retries: 1 });
  if (!res.ok) {
    throw new JobStepError(`Uploading ${file.filename} to Shopify's storage failed with HTTP ${res.status}.`, { service: 'shopify', code: String(res.status), suggestion: 'Retry this step; the signed upload target is requested again.', retryable: true });
  }
}

export interface AttachedMedia {
  id: string;
  alt: string | null;
  status: string;
}

/** One Admin request attaching every uploaded file to the product, in list order. */
export async function attachMedia(client: ShopifyClient, shopifyProductId: string, items: { resourceUrl: string; alt: string }[], meta: Meta): Promise<{ media: AttachedMedia[]; requestId: string | null }> {
  const media = items.map((i) => ({ originalSource: i.resourceUrl, mediaContentType: 'IMAGE', alt: i.alt }));
  const res = await client.graphql<{ productCreateMedia: { media: AttachedMedia[] | null; mediaUserErrors: { code: string | null; field: string[] | null; message: string }[] } }>('product_create_media', PRODUCT_CREATE_MEDIA_MUTATION, { productId: shopifyProductId, media }, meta);
  const out = res.data.productCreateMedia;
  if (out.mediaUserErrors.length) {
    const first = out.mediaUserErrors[0]!;
    throw new JobStepError(`Shopify did not add the media: ${out.mediaUserErrors.map((e) => e.message).join('; ')}`, { service: 'shopify', code: first.code, requestId: res.requestId, suggestion: 'Open the product in Shopify to check its media, then retry.' });
  }
  const list = out.media ?? [];
  if (list.length !== items.length) throw new JobStepError(`Shopify attached ${list.length} media items for ${items.length} files.`, { service: 'shopify', requestId: res.requestId });
  return { media: list, requestId: res.requestId };
}

export function altTextFor(title: string, aspect: string, slot: number): string {
  return `${title} (${aspect}, image ${slot})`.slice(0, 512);
}

export function stagedFile(finishedPath: string, bytes: number | null): StagedFile {
  return { filename: path.basename(finishedPath), path: finishedPath, bytes: bytes ?? 0 };
}
