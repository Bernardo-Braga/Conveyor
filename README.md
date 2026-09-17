# Conveyor

A local macOS control panel that takes a supplier link through to a Shopify draft, AI creatives and a paused Meta campaign. `Plan.md` is the specification; `CLAUDE.md` holds the hard rules.

## Setup

- Node 24 or newer, pnpm 10 (`corepack enable` picks the pinned version), `brew install exiftool`.
- Codex CLI installed and signed in with ChatGPT (`codex login`).
- Claude Code installed and signed in with your Claude plan (`claude auth login`). No Claude Console account or `ANTHROPIC_API_KEY` is needed; Conveyor strips keys from the writer's environment so the plan login is always used.
- Data lives in `~/Library/Application Support/Conveyor/data`. Override with `CONVEYOR_DATA_DIR`.
- Keys live in the macOS Keychain (service `Conveyor`). Add them under Settings, Connections.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Server on `http://127.0.0.1:4310` and the web app on `http://127.0.0.1:5173` (Vite proxies `/api`). |
| `pnpm test` | All tests. They never call an outside service. |
| `pnpm typecheck` | TypeScript strict across root scripts, shared, server and web. |
| `pnpm lint` | ESLint, including the "one HTTP path" and "no keytar, no shell" rules. |
| `pnpm db:generate` | Generate a Drizzle migration after changing `apps/server/src/db/schema.ts`. |
| `pnpm codex:smoke` | Manual. Runs the Codex image test three times (`--runs N --timeout S`). Uses the ChatGPT plan. |
| `pnpm writer:smoke` | Manual. Writes a listing with both local writers from the captured fixture (`--writer claude_code\|codex\|both`). Uses your Claude and ChatGPT plans, 0 API requests. |
| `pnpm capture:fixtures <aliexpress link> <1688 link>` | Manual. Exactly 2 RapidAPI requests. Saves the raw bodies in the app database and writes `fixtures/rapidapi/*.json` for the mapper tests. Needs the RapidAPI key in the Keychain. |

## Layout

```
apps/server   Hono API, job worker, SSE, SQLite (Drizzle), ledger client, Keychain wrapper
apps/web      React + Vite + Tailwind + Radix shell with the design tokens and the progress track
packages/shared   Zod schemas and types used by both apps
config/versions.ts   Pinned Meta, Shopify, Codex CLI and model versions
fixtures/     Recorded responses used by tests
scripts/      Manual scripts that make live calls
```
