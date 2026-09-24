/**
 * Meta test launch.
 *
 * Manual, run by the user: `pnpm meta:test-launch [--template ashworth|whitcombe|both] [--keep] [--dry-run]`.
 * `--dry-run` plans everything, asserts the payload rules and prints the counts with 0 requests.
 * For each template it creates a PAUSED campaign in the *test* ad account from Settings, with
 * finished JPEGs made from the engine fixture, checks every object exists and is PAUSED, and
 * deletes everything afterwards unless --keep is given. Nothing is ever set ACTIVE.
 *
 * Requests per template: 1 image upload batch + 1 object batch + 1 read + 1 delete batch.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template, type LaunchAdSet, type LaunchStructure } from '../packages/shared/src/index.ts';
import { createContext } from '../apps/server/src/context.ts';
import { finishCreative } from '../apps/server/src/images/finish.ts';
import { finishedFileName } from '../apps/server/src/images/store.ts';
import { launchCounts, planOperations, runObjectBatches } from '../apps/server/src/meta/launch.ts';
import { opError } from '../apps/server/src/meta/client.ts';
import { assertPayloadRules } from '../apps/server/src/meta/payloadRules.ts';
import { resolveVariantInterests } from '../apps/server/src/meta/interests.ts';
import { fillPattern, parseAgeBand, todayTag } from '../apps/server/src/meta/templates.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const which = (() => {
  const i = process.argv.indexOf('--template');
  return i >= 0 ? (process.argv[i + 1] ?? 'both') : 'both';
})();
const KEEP = process.argv.includes('--keep');
const DRY = process.argv.includes('--dry-run');
const FILES = { ashworth: 'ashworth-cbo.json', whitcombe: 'whitcombe-abo.json' } as const;

async function main() {
  const ctx = createContext();
  let failures = 0;
  try {
    const conn = ctx.settings.get('connections').meta;
    const act = conn.testAdAccountId || conn.adAccountId;
    if (!act) throw new Error('No test ad account ID under Settings, Accounts.');
    if (!conn.pageId) throw new Error('No Page ID under Settings, Accounts.');
    if (!DRY && !(await ctx.secrets.get('meta_access_token'))) throw new Error('No Meta access token in the Keychain. Add it under Connections.');
    if (DRY) console.log('Dry run: nothing is sent to Meta.\n');
    if (act === conn.adAccountId) console.log('Note: the test ad account is the same as the live one. Objects are created PAUSED and deleted at the end.\n');

    // Finished JPEGs from the real engine fixture, one per aspect, so uploads are genuine clean files.
    const original = await fs.readFile(path.join(ROOT, 'fixtures', 'images', 'codex-mug.png'));
    const dir = path.join(ctx.dataDir, 'workers', 'meta-test-launch');
    await fs.mkdir(dir, { recursive: true });
    const images: { id: number; fileName: string; data: Buffer }[] = [];
    for (const [i, aspect] of (['1:1', '4:5', '9:16'] as const).entries()) {
      const f = await finishCreative(original, aspect, 90);
      const fileName = finishedFileName('conveyor-test', aspect, i + 1);
      await fs.writeFile(path.join(dir, fileName), f.jpeg);
      images.push({ id: i + 1, fileName, data: f.jpeg });
    }

    const names = which === 'both' ? (['ashworth', 'whitcombe'] as const) : ([which as 'ashworth' | 'whitcombe'] as const);
    for (const name of names) {
      console.log(`=== ${name} ===`);
      const t = Template.parse(JSON.parse(await fs.readFile(path.join(ROOT, 'fixtures', 'templates', FILES[name]), 'utf8')));
      const created: Record<string, string> = {};
      try {
        // 1. Upload the three images in one batch with attached files (the "adimages in a batch" Confirm).
        const hashes = new Map<number, string>();
        if (DRY) {
          images.forEach((img) => hashes.set(img.id, `dryrun${img.id}`));
          console.log(`upload batch (planned): ${images.length} images in 1 request`);
        } else {
          const uploadOps = images.map((img, k) => ({ method: 'POST' as const, relative_url: `${act}/adimages`, name: `img${k}`, attached_files: `img${k}`, body: { name: img.fileName } }));
          const files = Object.fromEntries(images.map((img, k) => [`img${k}`, { data: img.data, filename: img.fileName, type: 'image/jpeg' }]));
          const up = await ctx.meta.batch(uploadOps, { purpose: 'test_adimages' }, files);
          up.results.forEach((r, k) => {
            const err = opError(r);
            if (err) throw new Error(`adimages op ${k} failed: ${err.message} (code ${err.code})`);
            hashes.set(images[k]!.id, Object.values((r.body as { images: Record<string, { hash: string }> }).images)[0]!.hash);
          });
          console.log(`upload batch: ${images.length} images, hashes ${[...hashes.values()].map((h) => h.slice(0, 8)).join(', ')}`);
        }

        // 2. Structure straight from the template (interests from the file or the cache; placeholders launch broad).
        const campaignName = `CONVEYOR TEST ${todayTag()} ${fillPattern(t.campaign.name_pattern, { date: todayTag(), template: t.name })}`;
        const adSets: LaunchAdSet[] = Array.from({ length: t.adset_count }, (_, i) => {
          const v = t.adset_variants[i] ?? { name: `Ad set ${i + 1}`, country: '', age_band: '', interests: [], custom_audiences: [] };
          const r = resolveVariantInterests(ctx.db, v, true);
          const band = parseAgeBand(v.age_band ?? '');
          return {
            index: i,
            name: fillPattern(t.adset.name_pattern, { campaign: campaignName, variation: v.name }),
            budgetMinor: t.campaign.budget.mode === 'ABO' ? t.adset.budget.daily_budget_minor : null,
            interestKind: r.kind,
            interestLabel: r.label,
            interests: r.interests,
            suggestions: r.suggestions,
            countryOverride: v.country || null,
            ageBand: band.ok ? band.range : null,
            ads: images.slice(0, t.ads_per_adset).map((img) => ({ creativeId: img.id, fileName: img.fileName, primaryText: t.ad.primary_text, headline: t.ad.headline, description: t.ad.description, destinationUrl: t.ad.destination_url })),
          };
        });
        const structure: LaunchStructure = { campaignName, adSets };
        const { ops, notes } = planOperations({ template: t, structure, adAccountId: act, pageId: conn.pageId, instagramUserId: conn.instagramUserId || null, pixelId: conn.pixelId || null, imageHashes: hashes, urlParams: t.ad.url_params, now: new Date(), keepTimeOfDay: false });
        for (const n of notes) console.log(`  note: ${n.scope}${n.index != null ? ` ${n.index + 1}` : ''}: ${n.message}`);
        const counts = launchCounts(structure, ops.filter((o) => o.relative_url.endsWith('adcreatives')).length, images.length);
        console.log(`object batch: ${counts.operations} operations in ${counts.batches} request(s) (${t.campaign.budget.mode})`);

        if (DRY) {
          assertPayloadRules(ops, t.campaign.budget.mode);
          const kinds = ops.map((o) => o.relative_url.split('/').pop());
          console.log(`payload rules: pass. ${kinds.filter((k) => k === 'campaigns').length} campaign, ${kinds.filter((k) => k === 'adsets').length} ad sets, ${kinds.filter((k) => k === 'adcreatives').length} creatives, ${kinds.filter((k) => k === 'ads').length} ads.`);
          const campaign = ops[0]!.body!;
          console.log(`campaign body: ${JSON.stringify({ ...campaign, name: undefined })}`);
          const set = ops.find((o) => o.relative_url.endsWith('adsets'))!.body!;
          console.log(`first ad set targeting: ${JSON.stringify(set.targeting)}`);
          console.log(`first ad set budget fields: daily_budget=${String(set.daily_budget)} bid_strategy=${String(set.bid_strategy)} start_time=${String(set.start_time)}\n`);
          continue;
        }
        // 3. Send. Payload rules are asserted inside runObjectBatches before each batch.
        const out = await runObjectBatches(ctx.meta, ops, t.campaign.budget.mode, {}, { productId: 0, jobId: null }, (n, id) => void (created[n] = id));
        if (out.failed.length) {
          failures += 1;
          console.log(`FAILED: ${out.failed.map((f) => `${f.name}: code ${f.code}${f.subcode ? `/${f.subcode}` : ''} ${f.message}`).join('; ')}`);
        } else {
          // 4. Read back: campaign and ad sets exist and are PAUSED.
          const camp = await ctx.meta.get<{ id: string; status: string; effective_status: string; name: string; daily_budget?: string; is_adset_budget_sharing_enabled?: boolean }>(created.campaign!, { fields: 'id,name,status,effective_status,daily_budget,is_adset_budget_sharing_enabled' }, { purpose: 'test_read' });
          const sets = await ctx.meta.get<{ data: { id: string; name: string; status: string; daily_budget?: string; targeting?: { age_min?: number; age_max?: number; targeting_automation?: unknown } }[] }>(`${created.campaign}/adsets`, { fields: 'id,name,status,daily_budget,targeting{age_min,age_max,targeting_automation}', limit: 50 }, { purpose: 'test_read' });
          console.log(`campaign ${camp.data.id} "${camp.data.name}" status ${camp.data.status}, daily_budget ${camp.data.daily_budget ?? '-'}, sharing ${camp.data.is_adset_budget_sharing_enabled ?? '-'}`);
          for (const s of sets.data.data) console.log(`  ad set ${s.id} ${s.status} budget ${s.daily_budget ?? '-'} targeting ${JSON.stringify(s.targeting)}`);
          const paused = camp.data.status === 'PAUSED' && sets.data.data.every((s) => s.status === 'PAUSED');
          const ids = Object.keys(created).length;
          console.log(paused && ids === ops.length ? `PASSED: ${ids} objects created, all PAUSED.` : `FAILED: paused=${paused}, ${ids}/${ops.length} objects.`);
          if (!(paused && ids === ops.length)) failures += 1;
        }
      } finally {
        if (created.campaign && !KEEP) {
          // Deleting the campaign removes its ad sets and ads. Creatives are deleted in the same batch.
          const delOps = [{ method: 'DELETE' as const, relative_url: created.campaign }, ...Object.entries(created).filter(([k]) => k.startsWith('cr')).map(([, id]) => ({ method: 'DELETE' as const, relative_url: id }))];
          const del = await ctx.meta.batch(delOps.slice(0, 50), { purpose: 'test_cleanup' });
          const bad = del.results.filter((r) => opError(r)).length;
          console.log(`cleanup: ${delOps.length} delete(s), ${bad} failed.\n`);
        } else if (created.campaign) console.log(`kept campaign ${created.campaign} (--keep).\n`);
      }
    }
    console.log(failures === 0 ? (DRY ? 'Dry run passed: both templates plan cleanly and pass the payload rules. Run without --dry-run to create them paused in Meta.' : 'Both templates created paused campaigns without errors.') : `${failures} template(s) failed.`);
  } finally {
    await ctx.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
