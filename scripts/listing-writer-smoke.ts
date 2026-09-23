/**
 * Listing writer smoke test (PLAN.md section 7, phase 3 "Confirm").
 *
 * Manual, run by the user: `pnpm writer:smoke [--writer claude_code|codex|both]`.
 * It writes a listing for the captured AliExpress fixture with the real CLIs, on your own
 * plans. No API key is used and no supplier request is made: the fixture is already on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ListingWriterId, WRITER_LABELS, type ListingWriterId as WriterId } from '../packages/shared/src/index.ts';
import { VERSIONS } from '../config/versions.ts';
import { createContext } from '../apps/server/src/context.ts';
import { mapAliexpress } from '../apps/server/src/suppliers/mapAliexpress.ts';
import { ensurePhotos } from '../apps/server/src/listing/photos.ts';
import { WriterError } from '../apps/server/src/listing/writers/index.ts';
import { recentTitles } from '../apps/server/src/products/repo.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'rapidapi', 'aliexpress-item.json');
/** The smoke run also proves the per-product focus reaches the writer. */
const FOCUS = 'Lead on the material and how it wears in; write for someone buying their first pair.';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main() {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`No captured fixture at ${path.relative(ROOT, FIXTURE)}. Run pnpm capture:fixtures first.`);
    process.exit(2);
  }
  const which = arg('writer', 'both');
  const ids: WriterId[] = which === 'both' ? ['claude_code', 'codex'] : [ListingWriterId.parse(which)];
  const source = mapAliexpress(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), { itemId: '3256812772817240', url: 'https://www.aliexpress.com/item/3256812772817240.html' });

  const ctx = createContext();
  const dir = path.join(ctx.dataDir, 'writer-smoke');
  fs.mkdirSync(dir, { recursive: true });
  let failures = 0;
  try {
    console.log(`Claude Code pinned ${VERSIONS.claudeCodeCli}, Codex pinned ${VERSIONS.codexCli}. Folder: ${dir}\n`);
    process.stdout.write('Downloading up to 4 supplier photos (no RapidAPI quota)… ');
    const photos = await ensurePhotos(ctx.ledger, source, dir, { productId: null, jobId: null });
    console.log(`${photos.files.length} ready (${photos.downloaded} new, ${photos.reused} reused).${photos.skipped.length ? ` Skipped: ${photos.skipped.join('; ')}` : ''}\n`);

    for (const id of ids) {
      const writer = ctx.writers[id];
      const availability = await writer.available();
      console.log(`${WRITER_LABELS[id]}: ${availability.reason}`);
      if (!availability.ok) {
        failures += 1;
        continue;
      }
      process.stdout.write('  writing… ');
      try {
        const run = await writer.write({ dir, source, brandVoice: ctx.settings.get('import').listing.brandVoice, instructions: ctx.settings.get('import').listing.instructions, focus: FOCUS, recentTitles: recentTitles(ctx.db), photos: photos.files, productId: null, jobId: null });
        console.log(`passed in ${(run.durationMs / 1000).toFixed(1)}s, ${run.attempts} attempt(s), ${run.apiRequests} API requests.`);
        console.log(`  title:      ${run.draft.title}`);
        console.log(`  type:       ${run.draft.productType}`);
        console.log(`  highlights: ${run.draft.highlights.join(' · ')}`);
        console.log(`  options:    ${JSON.stringify(run.draft.optionNames)}`);
        console.log(`  imageOrder: ${run.draft.imageOrder.join(', ')}`);
        console.log(`  verify:     ${run.draft.needsCheck.join(' · ') || '(nothing flagged)'}\n`);
      } catch (err) {
        failures += 1;
        const extra = err instanceof WriterError && err.usageLimit ? ' (usage limit: the hand-off would take over here)' : '';
        console.log(`FAILED${extra}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    console.log(failures === 0 ? 'All writers produced a valid listing with no API requests.' : `${failures} writer(s) did not produce a listing.`);
  } finally {
    await ctx.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
