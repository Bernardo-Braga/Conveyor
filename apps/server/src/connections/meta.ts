import { VERSIONS } from '../../../../config/versions.ts';
import { describeMetaError, explainMetaError, type MetaErrorBody } from '../meta/errors.ts';
import { result, type ConnectionTester } from './types.ts';

/**
 * One read-only Graph call. With an ad account configured it reads that account,
 * which also proves the system user is assigned to it; otherwise it reads `me`.
 * The token travels in the Authorization header, never in the URL.
 */
export const testMeta: ConnectionTester = async ({ ledger, secrets, settings, jobId }) => {
  const token = await secrets.require('meta_access_token');
  const { adAccountId } = settings.get('connections').meta;
  const path = adAccountId ? `${adAccountId}?fields=name,account_status,currency,timezone_name` : 'me?fields=id,name';
  const res = await ledger.fetch(
    { service: 'meta', purpose: 'connection_test', jobId },
    `https://graph.facebook.com/${VERSIONS.metaApi}/${path}`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  );
  const requestId = res.headers.get('x-fb-trace-id') ?? res.headers.get('x-fb-request-id');
  const body = (await res.json().catch(() => ({}))) as { error?: MetaErrorBody; id?: string; name?: string; account_status?: number; currency?: string };
  if (!res.ok || body.error) {
    const why = describeMetaError(body.error, res.status, requestId);
    const explain = explainMetaError(body.error?.code, body.error?.error_subcode);
    return result('meta', false, explain ? `${why} ${explain}` : why, 1, body.error?.fbtrace_id ?? requestId);
  }
  if (adAccountId) {
    const status = body.account_status === 1 ? 'active' : `status ${body.account_status ?? '?'}`;
    return result('meta', true, `Ad account ${body.name ?? adAccountId} reachable (${status}, ${body.currency ?? '?'}).`, 1, requestId);
  }
  return result('meta', true, `Token accepted for ${body.name ?? body.id ?? 'the system user'}. Add the ad account ID to check access to it.`, 1, requestId);
};
