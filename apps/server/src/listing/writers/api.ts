import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ListingWire } from '@conveyor/shared';
import { VERSIONS } from '../../../../../config/versions.ts';
import type { LedgerClient } from '../../http/ledgerClient.ts';
import type { Secrets } from '../../secrets/keychain.ts';
import { claudeClient } from '../claudeClient.ts';
import { focusNote, historyNote, listingRules, promptProduct } from '../prompt.ts';
import { validate } from './claudeCode.ts';
import { WriterError, type ListingWriter, type WriterRequest, type WriterRun } from './types.ts';

const MEDIA: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * The optional paid writer. Same prompt and schema as the CLI writers, but billed per
 * request, so it is never the default and is only offered when a key is set.
 */
export function apiWriter(deps: { ledger: LedgerClient; secrets: Secrets }): ListingWriter {
  return {
    id: 'claude_api',
    async available() {
      const key = await deps.secrets.get('claude_api_key');
      return key ? { ok: true, reason: 'Claude API key is set. Runs are billed per request.' } : { ok: false, reason: 'No Claude API key. Add one under Connections to use this writer.' };
    },
    async write(req: WriterRequest): Promise<WriterRun> {
      const started = Date.now();
      const key = await deps.secrets.require('claude_api_key');
      const client = claudeClient(deps.ledger, key, { purpose: 'listing', productId: req.productId, jobId: req.jobId });
      const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: listingRules(req.brandVoice, req.instructions), cache_control: { type: 'ephemeral' } }];
      const content: Anthropic.ContentBlockParam[] = [];
      for (const [i, name] of req.photos.entries()) {
        const media = MEDIA[path.extname(name).toLowerCase()];
        if (!media) continue;
        const data = await fs.readFile(path.join(req.dir, name), { encoding: 'base64' });
        content.push({ type: 'text', text: `Gallery image ${i}:` }, { type: 'image', source: { type: 'base64', media_type: media, data } });
      }
      // The history changes with every product, so it stays out of the cached system block.
      const history = historyNote(req.recentTitles);
      if (history) content.push({ type: 'text', text: history });
      const focus = focusNote(req.focus);
      if (focus) content.push({ type: 'text', text: focus });
      content.push({ type: 'text', text: `Supplier data (JSON):\n${JSON.stringify(promptProduct(req.source), null, 1)}\n\nWrite the listing.` });
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
      if (req.repairNote) messages.push({ role: 'user', content: `A previous attempt failed validation: ${req.repairNote}. Return a corrected listing.` });

      let apiRequests = 0;
      let lastProblem = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await client.messages
          .create({ model: VERSIONS.models.listing, max_tokens: 8_000, output_config: { effort: 'medium', format: zodOutputFormat(ListingWire) }, system, messages })
          .catch((err: unknown) => {
            throw toWriterError(err);
          });
        apiRequests += 1;
        if (res.stop_reason === 'refusal') throw new WriterError('Claude declined to write this listing.', 'claude_api');
        const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
        const parsed = validate({ result: text });
        if (parsed.error === null) {
          return { draft: parsed.draft, apiRequests, attempts: attempt, durationMs: Date.now() - started, reportedCostUsd: null, detail: `Claude API, ${res.usage.input_tokens} in / ${res.usage.output_tokens} out` };
        }
        lastProblem = parsed.error;
        messages.push({ role: 'assistant', content: text || '(no text)' }, { role: 'user', content: `Your listing did not pass validation: ${parsed.error}\nReturn the corrected listing in the same JSON format.` });
      }
      throw new WriterError(`The Claude API listing failed validation twice: ${lastProblem}`, 'claude_api', false, true);
    },
  };
}

function toWriterError(err: unknown): WriterError {
  if (err instanceof Anthropic.APIError) {
    const limited = err instanceof Anthropic.RateLimitError;
    return new WriterError(`Claude API error ${err.status ?? ''}: ${err.message}`, 'claude_api', limited, limited || (err.status ?? 0) >= 500);
  }
  return new WriterError(`Claude API request failed: ${err instanceof Error ? err.message : String(err)}`, 'claude_api', false, true);
}
