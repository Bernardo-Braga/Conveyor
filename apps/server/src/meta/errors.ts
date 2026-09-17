/**
 * Known Meta Marketing API error codes, explained in plain words.
 * Phase 6 extends this table alongside payloadRules.ts.
 */
export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

const EXPLANATIONS: Record<string, string> = {
  '100/4834011': 'ABO campaigns must send is_adset_budget_sharing_enabled: false. Conveyor always does; check the payload rules.',
  '100/4834002': 'A CBO campaign carries the budget; ad sets must not send one.',
  '100/4834005': 'Ad set budget sharing conditions failed. Sharing is always off in Conveyor.',
  '100/4834009': 'Ad set budget sharing conditions failed. Sharing is always off in Conveyor.',
  '100/3858418': 'Budget sharing cannot be changed on a live campaign. Live edits never touch it.',
  '190': 'The access token is invalid or expired. Generate a new system user token and save it under Connections.',
  '200': 'The token lacks a permission. The system user needs ads_management, ads_read and business_management on this ad account.',
  '10': 'The app or system user is not allowed to make this call. Check the ad account assignment.',
  '17': 'Meta rate limit reached. Wait a few minutes and retry.',
  '613': 'Meta rate limit reached for this ad account. Wait a few minutes and retry.',
  '100/3858504': 'The creative bundle field standard_enhancements is deprecated; Conveyor sets each enhancement feature individually. If you see this, the payload rules were bypassed.',
  '100/1885183': 'The Meta app that owns this token is in Development mode, so ads cannot be created (campaign, ad sets and uploads still succeed). Switch the app to Live in the Meta developer dashboard.',
  '1': 'Meta returned "unknown error" (code 1). This is usually a malformed targeting spec: an empty list, a bare interest id, or an audience combined with Advantage+ audience. Use "Check targeting with Meta" on the Launch view to find the field.',
  '80004': 'Ads API throttled for this ad account. Wait and retry; Conveyor batches writes to stay under the limit.',
};

export function explainMetaError(code: number | undefined, subcode: number | undefined): string | null {
  if (code == null) return null;
  return EXPLANATIONS[`${code}/${subcode ?? ''}`] ?? EXPLANATIONS[String(code)] ?? null;
}

/** "code 190 / subcode 460: Error validating access token (request abc123)" */
export function describeMetaError(e: MetaErrorBody | undefined, status: number, requestId: string | null): string {
  if (!e) return `Meta returned HTTP ${status}${requestId ? ` (request ${requestId})` : ''}.`;
  const parts = [`code ${e.code ?? '?'}`];
  if (e.error_subcode != null) parts.push(`subcode ${e.error_subcode}`);
  const rid = e.fbtrace_id ?? requestId;
  // `message` alone is often just "Invalid parameter"; the actionable text is error_user_msg (the other tool's bug 3).
  const text = [e.message, e.error_user_title && e.error_user_title !== e.message ? e.error_user_title : null, e.error_user_msg && e.error_user_msg !== e.message ? e.error_user_msg : null].filter(Boolean).join(' — ') || 'no message';
  return `Meta error ${parts.join(' / ')}: ${text}${rid ? ` (request ${rid})` : ''}.`;
}
