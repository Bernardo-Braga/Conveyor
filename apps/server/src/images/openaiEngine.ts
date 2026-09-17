import fs from 'node:fs/promises';
import path from 'node:path';
import { GEN_SIZE, type Aspect, type ImageSettings } from '@conveyor/shared';
import { VERSIONS } from '../../../../config/versions.ts';
import type { Db } from '../db/index.ts';
import { costs } from '../db/schema.ts';
import type { LedgerClient } from '../http/ledgerClient.ts';
import type { Secrets } from '../secrets/keychain.ts';
import { looksLikeUsageLimit } from '../listing/writers/types.ts';
import type { EngineOutcome, EngineSlot, ImageEngine } from './engine.ts';

const EDITS_URL = 'https://api.openai.com/v1/images/edits';
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** The parts of the Images API response Conveyor reads. */
interface EditsResponse {
  data?: { b64_json?: string; url?: string }[];
  usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
  error?: { message?: string; type?: string; code?: string | null; param?: string | null };
}

export interface OpenAiEngineDeps {
  ledger: LedgerClient;
  secrets: Secrets;
  db: Db;
  settings: ImageSettings['openai'];
  jobId?: number | null;
}

/**
 * The backup engine (PLAN.md section 8): `gpt-image-2` through the images edit endpoint with
 * the reference images attached, one request per format asking for all of that format's images,
 * PNG output so compression happens once, sizes with edges in multiples of 16. Usage from each
 * response goes to the cost ledger. If the API refuses `n` above 1, the format is retried one
 * image per request.
 */
export function openaiEngine(deps: OpenAiEngineDeps): ImageEngine {
  return {
    id: 'openai',
    async available() {
      const key = await deps.secrets.get('openai_api_key');
      return key ? { ok: true, reason: `OpenAI ${VERSIONS.models.openaiImage}, billed per request.` } : { ok: false, reason: 'No OpenAI API key. Add one under Connections to use the backup engine.' };
    },

    async generate(req, events) {
      const key = await deps.secrets.require('openai_api_key');
      const groups = new Map<Aspect, EngineSlot[]>();
      for (const s of req.slots) groups.set(s.aspect, [...(groups.get(s.aspect) ?? []), s]);
      const references = await Promise.all(req.referencePaths.map(async (p) => ({ name: path.basename(p), type: MIME[path.extname(p).toLowerCase()] ?? 'image/png', data: await fs.readFile(p) })));
      const edit = req.edit ? { name: path.basename(req.edit.path), type: MIME[path.extname(req.edit.path).toLowerCase()] ?? 'image/jpeg', data: await fs.readFile(req.edit.path) } : null;
      const prompt = req.edit ? `${req.prompt}\n\nThe first image is the one to edit: keep everything about it except this change: ${req.edit.instruction}` : req.prompt;

      const produced: number[] = [];
      let apiRequests = 0;
      let failures = 0;
      let stop: EngineOutcome['handoff'] = null;
      const total = req.slots.length;

      const request = async (aspect: Aspect, n: number): Promise<{ images: Buffer[] } | { error: string; status: number | null; param: string | null; limit: boolean }> => {
        const [w, h] = GEN_SIZE[aspect];
        const form = new FormData();
        form.set('model', VERSIONS.models.openaiImage);
        form.set('prompt', prompt);
        form.set('n', String(n));
        form.set('size', `${w}x${h}`);
        form.set('quality', deps.settings.quality);
        form.set('output_format', 'png');
        // gpt-image-2 always uses high input fidelity; input_fidelity must not be sent.
        const inputs = edit ? [edit, ...references] : references;
        for (const img of inputs) form.append('image[]', new Blob([new Uint8Array(img.data)], { type: img.type }), img.name);
        const res = await deps.ledger.fetch(
          { service: 'openai', purpose: 'image_edit', productId: req.productId, jobId: deps.jobId ?? null },
          EDITS_URL,
          { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form },
          { timeoutMs: 300_000, retries: 1 },
        );
        apiRequests += 1;
        const body = (await res.json().catch(() => ({}))) as EditsResponse;
        if (!res.ok || body.error) {
          const message = body.error?.message ?? `HTTP ${res.status}`;
          const limit = res.status === 429 || body.error?.code === 'insufficient_quota' || body.error?.type === 'insufficient_quota' || looksLikeUsageLimit(message);
          return { error: message, status: res.status, param: body.error?.param ?? null, limit };
        }
        if (body.usage) {
          deps.db
            .insert(costs)
            .values({ jobId: deps.jobId ?? null, service: 'openai', units: { model: VERSIONS.models.openaiImage, aspect, n, quality: deps.settings.quality, ...body.usage }, amountMinor: 0 })
            .run();
        }
        const images: Buffer[] = [];
        for (const d of body.data ?? []) if (d.b64_json) images.push(Buffer.from(d.b64_json, 'base64'));
        return { images };
      };

      const deliver = async (slots: EngineSlot[], images: Buffer[]) => {
        for (const [i, buf] of images.entries()) {
          const slot = slots[i];
          if (!slot) break;
          try {
            await events.onImage(slot, buf);
            produced.push(slot.creativeId);
            events.log(`${slot.aspect} image ${String(slot.slot).padStart(2, '0')} arrived from OpenAI.`);
          } catch (err) {
            events.log(`Could not finish an OpenAI image for slot ${slot.slot}: ${err instanceof Error ? err.message : String(err)}`, 'warn');
          }
        }
        events.progress(produced.length, total);
      };

      for (const [aspect, slots] of groups) {
        if (stop) break;
        const batchMode = deps.settings.oneRequestPerFormat && slots.length > 1;
        const first = await request(aspect, batchMode ? slots.length : 1);
        if ('images' in first) {
          await deliver(slots, first.images);
          if (batchMode) continue;
          // One-per-request mode: the rest of the format, one call each.
          for (const slot of slots.slice(1)) {
            if (stop) break;
            const r = await request(aspect, 1);
            if ('images' in r) await deliver([slot], r.images);
            else if (r.limit) stop = { reason: `OpenAI stopped: ${r.error}`, usageLimit: true };
            else failures += 1;
          }
          continue;
        }
        if (first.limit) {
          stop = { reason: `OpenAI stopped: ${first.error}`, usageLimit: true };
          break;
        }
        // The Confirm item in the plan: if the API refuses several images per request, fall back to one per request.
        const refusesN = batchMode && first.status === 400 && (first.param === 'n' || /\bn\b/.test(first.error));
        if (refusesN) {
          events.log(`OpenAI refused ${slots.length} images in one request (${first.error}). Falling back to one image per request.`, 'warn');
          for (const slot of slots) {
            if (stop) break;
            const r = await request(aspect, 1);
            if ('images' in r) await deliver([slot], r.images);
            else if (r.limit) stop = { reason: `OpenAI stopped: ${r.error}`, usageLimit: true };
            else failures += 1;
          }
          continue;
        }
        failures += 1;
        events.log(`OpenAI request for ${aspect} failed: ${first.error}`, 'warn');
        if (failures >= 2) {
          stop = { reason: `${failures} OpenAI requests failed; the last error was: ${first.error}`, usageLimit: false };
          break;
        }
      }

      const remaining = req.slots.filter((s) => !produced.includes(s.creativeId));
      return { producedCreativeIds: produced, remaining, handoff: remaining.length && stop ? stop : null, apiRequests, tasks: groups.size, failures };
    },
  };
}
