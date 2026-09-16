import { VERSIONS } from '../../../../config/versions.ts';
import { result, type ConnectionTester } from './types.ts';

/** One read-only call: fetch the pinned image model. Confirms the key has access to it. */
export const testOpenAI: ConnectionTester = async ({ ledger, secrets, jobId }) => {
  const key = await secrets.require('openai_api_key');
  const model = VERSIONS.models.openaiImage;
  const res = await ledger.fetch(
    { service: 'openai', purpose: 'connection_test', jobId },
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
    { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } },
  );
  const requestId = res.headers.get('x-request-id');
  if (res.ok) {
    const body = (await res.json()) as { id?: string; owned_by?: string };
    return result('openai', true, `Key accepted. Model ${body.id ?? model} is available.`, 1, requestId);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const why = body.error ? `${body.error.code ?? 'error'}: ${body.error.message ?? ''}` : `HTTP ${res.status}`;
  const fix = res.status === 401 ? ' Check the key under Connections.' : res.status === 404 ? ` The key has no access to ${model}, or the pinned model ID is wrong.` : '';
  return result('openai', false, `OpenAI ${why}${requestId ? ` (request ${requestId})` : ''}.${fix}`, 1, requestId);
};
