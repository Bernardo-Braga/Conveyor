# Conveyor

A local macOS control panel that takes a supplier link through to a Shopify draft, AI creatives and a paused Meta campaign. `Plan.md` is the specification; `CLAUDE.md` holds the hard rules.

## Setup

- Node 24 or newer, pnpm 10 (`corepack enable` picks the pinned version), `brew install exiftool`.
- Codex CLI installed and signed in with ChatGPT (`codex login`). Image workers and the fallback listing writer run on that plan.
- Optional: an OpenAI API key with `gpt-image-2` access, for the backup image engine that takes over after a Codex plan limit or two failed tasks.
- Claude Code installed and signed in with your Claude plan (`claude auth login`). No Claude Console account or `ANTHROPIC_API_KEY` is needed; Conveyor strips keys from the writer's environment so the plan login is always used.
- Backups: Settings, Maintenance, "Back up now" writes one zip under the data directory's `backups/` (database, templates, product folders; never keys). The ten newest are kept.
- Data lives in `~/Library/Application Support/Conveyor/data`. Override with `CONVEYOR_DATA_DIR`. Each product gets a folder under `products/` (listing photos, references, creatives); Codex image workers run under `workers/`; Meta templates are JSON files under `templates/`, edited from the Templates tab.
- Keys live in the macOS Keychain (service `Conveyor`). Add them under Settings, Connections. The Meta system user token needs `ads_management`, `ads_read`, `business_management` and `pages_read_engagement`; the Meta app secret is optional and only needed when the app requires `appsecret_proof`.
- `META-API-HANDOFF.md` records what the previous launcher learned about the Marketing API; the payload rules and their tests encode it.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Server on `http://127.0.0.1:4310` and the web app on `http://127.0.0.1:5173` (Vite proxies `/api`). |
| `pnpm start` | The current version as one process: builds the web app, then serves it and the API from the server at `http://127.0.0.1:4310`. Stop with Ctrl-C. |
| `pnpm build` | Builds the web app into `apps/web/dist`, which the server serves when present. |
| `pnpm start-at-login install\|uninstall\|status` | Installs a user LaunchAgent that runs the server at login in production mode. The same switch is under Settings, Maintenance. |
| `pnpm test` | All tests. They never call an outside service. |
| `pnpm typecheck` | TypeScript strict across root scripts, shared, server and web. |
| `pnpm lint` | ESLint, including the "one HTTP path" and "no keytar, no shell" rules. |
| `pnpm db:generate` | Generate a Drizzle migration after changing `apps/server/src/db/schema.ts`. |
| `pnpm codex:smoke` | Manual. Runs the Codex image test three times (`--runs N --timeout S`). Uses the ChatGPT plan. |
| `pnpm meta:test-launch [--template ashworth\|whitcombe\|both] [--keep] [--dry-run]` | Manual. Creates a paused campaign per template in the test ad account from Settings, reads it back, and deletes it. `--dry-run` plans and checks everything with 0 requests. |
| `pnpm writer:smoke` | Manual. Writes a listing with both local writers from the captured fixture (`--writer claude_code\|codex\|both`). Uses your Claude and ChatGPT plans, 0 API requests. |
| `pnpm capture:fixtures <aliexpress link> <1688 link>` | Manual. Exactly 2 RapidAPI requests. Saves the raw bodies in the app database and writes `fixtures/rapidapi/*.json` for the mapper tests. Needs the RapidAPI key in the Keychain. |

## Layout

```
apps/server   Hono API, job worker, SSE, SQLite (Drizzle), ledger client, Keychain wrapper
apps/web      React + Vite + Tailwind + Radix shell with the design tokens and the progress track
packages/shared   Zod schemas and types used by both apps
config/versions.ts   Pinned Meta, Shopify, Codex CLI and model versions
fixtures/     Recorded responses used by tests, plus real Codex engine output under images/
scripts/      Manual scripts that make live calls
```
