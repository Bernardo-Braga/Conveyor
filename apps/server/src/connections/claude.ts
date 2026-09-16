import { VERSIONS } from '../../../../config/versions.ts';
import { result, type ConnectionTester } from './types.ts';

/** One read-only call: fetch the pinned listing model. Confirms the key and the model ID together. */
export const testClaude: ConnectionTester = async ({ ledger, secrets, jobId }) => {
  const key = await secrets.require('claude_api_key');
  const model = VERSIONS.models.listing;
  const res = await ledger.fetch(
    { service: 'claude', purpose: 'connection_test', jobId },
    `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
    { headers: { 'x-api-key': key, 'anthropic-version': VERSIONS.anthropicVersion, accept: 'application/json' } },
  );
  const requestId = res.headers.get('request-id');
  if (res.ok) {
    const body = (await res.json()) as { id?: string; display_name?: string };
    return result('claude', true, `Key accepted. Model ${body.id ?? model}${body.display_name ? ` (${body.display_name})` : ''} is available.`, 1, requestId);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
  const why = body.error ? `${body.error.type ?? 'error'}: ${body.error.message ?? ''}` : `HTTP ${res.status}`;
  const fix = res.status === 401 ? ' Check the key under Connections.' : res.status === 404 ? ` The pinned model ID ${model} was not found; update config/versions.ts.` : '';
  return result('claude', false, `Claude ${why}${requestId ? ` (request ${requestId})` : ''}.${fix}`, 1, requestId);
};
