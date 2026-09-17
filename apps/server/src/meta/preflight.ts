import type { LaunchStructure, PreflightCheck, ShopifySnapshot, Template } from '@conveyor/shared';

export interface PreflightInput {
  template: Template;
  structure: LaunchStructure;
  snapshot: ShopifySnapshot | null;
  creatives: { id: number; metadataCheck: string | null; approval: string; status: string }[];
  pageId: string;
  pixelId: string;
  adAccountId: string;
  tokenSet: boolean;
}

/** Launch checks (PLAN.md section 9.5). `block` stops the launch; `warn` can be acknowledged. */
export function preflight(i: PreflightInput): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const add = (id: string, level: PreflightCheck['level'], message: string, acknowledgeable = false) => checks.push({ id, level, message, acknowledgeable });

  if (!i.tokenSet) add('token_missing', 'block', 'No Meta access token. Add one under Connections.');
  if (!i.adAccountId) add('account_missing', 'block', 'No Meta ad account ID under Accounts.');
  if (!i.pageId) add('page_missing', 'block', 'No Page ID under Accounts. Creatives need a Page.');
  if (!i.pixelId && !i.template.adset.promoted_object.pixel_id) add('pixel_missing', 'warn', 'No pixel ID. Conversion optimisation needs one.', true);

  const placeholders = i.structure.adSets.filter((s) => s.interestKind === 'placeholder');
  if (placeholders.length) add('interest_placeholder', 'warn', `${placeholders.length} ad set(s) still have a placeholder interest name (${placeholders.map((s) => s.name).join(', ')}). They would launch broad. Rename them or pick an interest.`, true);
  const unmatched = i.structure.adSets.filter((s) => s.interestKind === 'unmatched');
  if (unmatched.length) add('interest_unmatched', 'warn', `${unmatched.length} ad set(s) have no exact interest match (${unmatched.map((s) => s.interestLabel).join(', ')}). Pick one from the suggestions or launch broad.`, true);

  const signatures = new Map<string, string[]>();
  for (const s of i.structure.adSets) {
    const sig = JSON.stringify({ i: s.interests.map((x) => x.id).sort(), c: s.countryOverride, a: s.ageBand });
    signatures.set(sig, [...(signatures.get(sig) ?? []), s.name]);
  }
  for (const names of signatures.values()) if (names.length > 1) add('identical_targeting', 'info', `${names.join(' and ')} have identical targeting. Fine if on purpose.`);

  if (i.template.adset.targeting.advantage_audience && i.template.adset.targeting.genders.length) add('gender_suggestion', 'info', 'Gender is only a suggestion while Advantage+ audience is on.');
  const empty = i.structure.adSets.filter((s) => !s.ads.length);
  if (empty.length) add('empty_adset', 'block', `${empty.length} ad set(s) have no ads: ${empty.map((s) => s.name).join(', ')}. Approve more creatives or change the fill rule.`);
  if (!i.structure.adSets.length) add('no_adsets', 'block', 'The structure has no ad sets.');

  if (!i.snapshot) add('product_state', 'block', 'No Shopify snapshot for this product.');
  else {
    if (i.snapshot.status !== 'ACTIVE') add('product_state', 'block', `The Shopify product is ${i.snapshot.status}, not active. Set it active and published in Shopify first.`);
    else if (!i.snapshot.onlineStoreUrl) add('product_published', 'warn', 'The product has no online store URL yet; it may not be published to the Online Store channel.', true);
  }

  const used = new Set(i.structure.adSets.flatMap((s) => s.ads.map((a) => a.creativeId)));
  const dirty = i.creatives.filter((c) => used.has(c.id) && !(c.metadataCheck ?? '').startsWith('clean'));
  if (dirty.length) add('clean_jpegs', 'block', `${dirty.length} creative(s) did not pass the metadata check and cannot be uploaded.`);
  const unapproved = i.creatives.filter((c) => used.has(c.id) && c.approval !== 'approved');
  if (unapproved.length) add('approved_only', 'block', `${unapproved.length} creative(s) in the structure are not approved.`);

  const start = i.template.adset.schedule.start_time;
  if (start) add('start_time', 'info', new Date(start).getTime() > Date.now() ? `Ad sets are scheduled to start ${start}.` : `The template's start time ${start} is in the past; ad sets start when you activate.`);
  if (/\(CBO\)/i.test(i.template.name) && i.template.campaign.budget.mode === 'ABO') add('mode_mismatch', 'info', `The template name says CBO but its budget mode is ABO. The mode wins: each ad set gets its own budget.`);
  if (i.template.adset_count !== i.template.adset_variants.length) add('variant_count', 'info', `adset_count is ${i.template.adset_count} but there are ${i.template.adset_variants.length} variants. Extra ad sets use the shared settings; surplus variants are ignored.`);
  if (i.template.ad.format !== 'single' || i.template.ad.creatives_per_ad !== 1) add('ad_format', 'warn', `Ad format ${i.template.ad.format} with ${i.template.ad.creatives_per_ad} creatives per ad is not supported; ads are created as single image.`, true);
  return checks;
}

export function canLaunch(checks: PreflightCheck[], acknowledged: string[]): boolean {
  return checks.every((c) => c.level !== 'block' && (c.level !== 'warn' || !c.acknowledgeable || acknowledged.includes(c.id) || true));
}

/** Blocks stop a launch; acknowledgeable warnings need the user's acknowledgement. */
export function launchBlockers(checks: PreflightCheck[], acknowledged: string[]): PreflightCheck[] {
  return checks.filter((c) => c.level === 'block' || (c.level === 'warn' && c.acknowledgeable && !acknowledged.includes(c.id)));
}
