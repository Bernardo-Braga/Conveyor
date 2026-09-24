/**
 * Capture one real DataHub response per platform.
 *
 * Manual, run by the user: `pnpm capture:fixtures <aliexpress link> <1688 link>`.
 * Exactly 2 RapidAPI requests. Both go through the ledger and the raw bodies are saved
 * in the app database first, so pasting the same links later costs 0 requests.
 * The bodies are then written to fixtures/rapidapi/ for the mapper tests.
 *
 * Needs the RapidAPI key in the Keychain (Settings, Connections in the app).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../apps/server/src/context.ts';
import { parseLink } from '../apps/server/src/suppliers/parseLink.ts';
import { mapItem } from '../apps/server/src/suppliers/mapItem.ts';
import { dataHubStatus } from '../apps/server/src/suppliers/rapidapi.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = { aliexpress: 'aliexpress-item.json', '1688': '1688-item.json' } as const;

async function main() {
  const links = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const force = process.argv.includes('--force');
  if (links.length === 0) {
    console.error('Usage: pnpm capture:fixtures <aliexpress link> <1688 link> [--force]');
    process.exit(2);
  }
  const parsed = links.map((l) => ({ link: l, p: parseLink(l) }));
  const bad = parsed.filter((x) => !x.p);
  if (bad.length) {
    console.error(`Not a supported link: ${bad.map((b) => b.link).join(', ')}`);
    process.exit(2);
  }
  const platforms = new Set(parsed.map((x) => x.p!.platform));
  if (platforms.size !== parsed.length) {
    console.error('Give one link per platform.');
    process.exit(2);
  }

  const ctx = createContext();
  try {
    if (!(await ctx.secrets.get('rapidapi_key'))) {
      console.error('No RapidAPI key in the Keychain. Add it under Settings, Connections, then rerun.');
      process.exit(2);
    }
    let requests = 0;
    for (const { link, p } of parsed) {
      const { platform, itemId } = p!;
      const file = path.join(ROOT, 'fixtures', 'rapidapi', OUT[platform]);
      if (fs.existsSync(file) && !force) {
        console.log(`${platform}: ${path.relative(ROOT, file)} exists, skipping (use --force to refetch). 0 requests.`);
        continue;
      }
      process.stdout.write(`${platform} ${itemId}: fetching… `);
      const before = ctx.quota.get(platform).remaining;
      const res = await ctx.rapidapi.fetchItem(platform, itemId);
      requests += 1;
      const after = ctx.quota.get(platform);
      const status = dataHubStatus(res.body);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(res.body, null, 2)}\n`);
      console.log(`HTTP ${res.httpStatus}, DataHub status ${status.code ?? 'n/a'}. Saved raw #${res.rawId} and ${path.relative(ROOT, file)}.`);
      console.log(`  quota: ${before ?? '?'} → ${after.remaining ?? '?'} remaining${after.resetAt ? `, resets ${after.resetAt}` : ''}`);
      try {
        const sp = mapItem(platform, res.body, { itemId, url: link });
        console.log(`  provisional mapping: "${sp.title.slice(0, 60)}", ${sp.images.length} images, ${sp.options.length} options, ${sp.variants.length} variants, ${sp.currency}${sp.moq ? `, MOQ ${sp.moq}` : ''}`);
        const top = Object.keys((res.body as { result?: { item?: object } }).result?.item ?? {});
        console.log(`  result.item keys: ${top.join(', ') || '(no result.item; inspect the fixture)'}`);
      } catch (err) {
        console.log(`  provisional mapping failed (expected until the mappers are fitted to this fixture): ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
    }
    console.log(`\nDone. ${requests} RapidAPI request(s) made. Now run: pnpm test`);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
