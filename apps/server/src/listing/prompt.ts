import { MAX_PHOTOS, type SourceProduct } from '@conveyor/shared';

/** The rules every writer follows, whatever runs it. */
export function listingRules(brandVoice: string): string {
  return [
    'You write Shopify product listings for a small direct-to-consumer store.',
    'Rules:',
    '- Write in natural English for shoppers. Translate any Chinese titles, option names and option values.',
    '- Do not invent materials, sizes, certifications, origins, awards or performance claims. Use only what the supplier data and the photos show. Put anything you are unsure about in needsCheck instead of the copy.',
    '- The title is at most 70 characters, specific and free of keyword stuffing.',
    '- descriptionHtml uses only <p>, <ul>, <li> and <strong>. Two or three short paragraphs plus a bullet list of what is included or key specs.',
    '- highlights are 3 to 5 short benefit statements.',
    '- imageOrder lists the indexes of the supplier gallery images to keep, best hero image first. Drop images that are mostly text, size charts or collages.',
    '- optionNames and optionValues map every source option name and value to a clean English label, even when the source is already English (then tidy the casing).',
    '- productType is a short category such as "Loafers" or "Desk lamp".',
    '- tags are lower-case, 3 to 10 of them, no duplicates of the product type.',
    '- seo.title is at most 60 characters, seo.description at most 160.',
    '- No exclamation marks. Sentence case for headings.',
    brandVoice.trim() ? `Brand voice:\n${brandVoice.trim()}` : 'Brand voice: plain, warm and specific.',
  ].join('\n');
}

/** Trimmed source for the prompt: no seller, review or delivery data. */
export function promptProduct(sp: SourceProduct) {
  return {
    platform: sp.source.platform,
    title: sp.title,
    descriptionText: sp.descriptionText.slice(0, 4000),
    attributes: sp.attributes,
    options: sp.options.map((o) => ({ name: o.name, values: o.values.map((v) => v.label) })),
    variantCount: sp.variants.length,
    currency: sp.currency,
    galleryImageCount: sp.images.length,
    ...(sp.moq ? { moq: sp.moq } : {}),
  };
}

/**
 * The single prompt handed to a CLI writer. `photos` are file names already saved in the
 * working directory, which the writer is told to read before writing.
 */
export function listingPrompt(sp: SourceProduct, brandVoice: string, photos: readonly string[], repairNote?: string): string {
  const parts = [listingRules(brandVoice), ''];
  if (photos.length) {
    parts.push(`First read these product photos in this folder, in order: ${photos.join(', ')}.`, 'They are the supplier\'s own gallery images, numbered by their gallery index.', '');
  } else {
    parts.push('No photos are available for this product. Work from the supplier data alone and be conservative.', '');
  }
  parts.push(`Supplier data (JSON):\n${JSON.stringify(promptProduct(sp), null, 1)}`, '');
  if (repairNote) parts.push(`Your previous reply did not pass validation: ${repairNote}`, 'Return a corrected listing.', '');
  parts.push('Return only the listing as JSON matching the required schema. Do not write any files.');
  return parts.join('\n');
}

export { MAX_PHOTOS };
