import { HISTORY_TITLES, MAX_PHOTOS, type SourceProduct } from '@conveyor/shared';

/** The rules every writer follows, whatever runs it. Stable across products, so the API writer can cache it. */
export function listingRules(brandVoice: string, instructions = ''): string {
  return [
    'You write Shopify product listings for a small direct-to-consumer store.',
    'Rules:',
    '- Write in natural English for shoppers. Translate any Chinese titles, option names and option values.',
    '- Do not invent materials, sizes, certifications, origins, awards or performance claims. Use only what the supplier data and the photos show. Put anything you are unsure about in needsCheck instead of the copy.',
    '- The title is at most 70 characters, specific and free of keyword stuffing.',
    '- descriptionHtml uses only <p>, <ul>, <li> and <strong>. Two or three short paragraphs plus a bullet list of what is included or key specs.',
    '- highlights are 3 to 5 short benefit statements.',
    '- imageOrder ranks only the photos you were given to read, by their gallery index, best hero image first. Drop the ones that are mostly text, size charts or collages. Never list an index you were not shown: the rest of the gallery is kept as it is.',
    '- optionNames and optionValues map every source option name and value to a clean English label, even when the source is already English (then tidy the casing).',
    '- productType is a short category such as "Loafers" or "Desk lamp".',
    '- tags are lower-case, 3 to 10 of them, no duplicates of the product type.',
    '- seo.title is at most 60 characters, seo.description at most 160.',
    '- No exclamation marks. Sentence case for headings.',
    brandVoice.trim()
      ? `The store's own instructions for titles, descriptions and tone follow. Where they differ from the style rules above, follow them. They never override the character limits, the allowed HTML tags, or the rule against inventing facts.\n${brandVoice.trim()}`
      : 'Brand voice: plain, warm and specific.',
    ...(instructions.trim()
      ? [`The store's standing rules for every listing follow. Treat them as rules, not suggestions, and follow them even where they narrow the style rules above. They never override the character limits, the allowed HTML tags, or the rule against inventing facts.\n${instructions.trim()}`]
      : []),
  ].join('\n');
}

/**
 * The names this store has already used. The writer gets them so a second pair of loafers does
 * not become the same listing title as the first. It is the one part of the prompt that changes
 * between products of the same store, so it never goes in a cached system block.
 */
export function historyNote(titles: readonly string[]): string | null {
  const seen: string[] = [];
  for (const t of titles) {
    const clean = t.trim();
    if (clean && !seen.some((s) => s.toLowerCase() === clean.toLowerCase())) seen.push(clean);
    if (seen.length >= HISTORY_TITLES) break;
  }
  if (!seen.length) return null;
  return [
    'Titles this store has already published, newest first:',
    ...seen.map((t) => `- ${t}`),
    'Give this product its own name. Do not reuse one of these titles, and do not write one that differs from a listed title only by a word or a number. Reusing the store\'s own naming pattern is right; reusing the name is not. If this product really is a repeat of one of them, write the listing anyway and say so in needsCheck.',
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
 * What this one product's listing should lean on, typed in the input bar before the import.
 * It steers the copy; it never licenses a claim the supplier data and photos do not support.
 */
export function focusNote(focus: string): string | null {
  const f = focus.trim();
  if (!f) return null;
  return [
    `Focus for this listing: ${f}`,
    'Lead with it in the title, the opening paragraph and the highlights, in your own words. If the supplier data and the photos do not support it, write what they do support and put the rest in needsCheck. Never invent a fact to fit the focus.',
  ].join('\n');
}

/** What a CLI writer is asked beyond the base rules: the store's rules, the history, the focus, the repair note. */
export interface PromptExtras {
  /** This product's own direction, from the input bar. */
  focus?: string;
  /** The store's standing rules, from Settings. */
  instructions?: string;
  /** Set on the second attempt, quoting what failed validation. */
  repairNote?: string;
  /** Titles already used in this store, newest first, so a name is not used twice. */
  recentTitles?: readonly string[];
}

/**
 * The single prompt handed to a CLI writer. `photos` are file names already saved in the
 * working directory, which the writer is told to read before writing.
 */
export function listingPrompt(sp: SourceProduct, brandVoice: string, photos: readonly string[], extras: PromptExtras = {}): string {
  const { focus = '', repairNote, instructions = '', recentTitles = [] } = extras;
  const parts = [listingRules(brandVoice, instructions), ''];
  const history = historyNote(recentTitles);
  if (history) parts.push(history, '');
  const note = focusNote(focus);
  if (note) parts.push(note, '');
  if (photos.length) {
    parts.push(
      `First read these product photos in this folder, in order: ${photos.join(', ')}.`,
      `They are the supplier's own gallery images, numbered by their gallery index. They are ${photos.length} of the ${sp.images.length} gallery images; the others are kept after your picks, so imageOrder covers only these ${photos.length}.`,
      '',
    );
  } else {
    parts.push('No photos are available for this product. Work from the supplier data alone and be conservative.', '');
  }
  parts.push(`Supplier data (JSON):\n${JSON.stringify(promptProduct(sp), null, 1)}`, '');
  if (repairNote) parts.push(`Your previous reply did not pass validation: ${repairNote}`, 'Return a corrected listing.', '');
  parts.push('Return only the listing as JSON matching the required schema. Do not write any files.');
  return parts.join('\n');
}

export { HISTORY_TITLES, MAX_PHOTOS };
