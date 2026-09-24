# Conveyor

Conveyor is a local web app for macOS. Paste a supplier link from AliExpress or 1688 and it takes the product through to:

1. **A Shopify draft.** Conveyor imports the supplier data and photos, prices the product, and writes the listing.
2. **Ad creatives.** Conveyor generates AI images in the Studio, finishes them to Meta's sizes, and you approve the ones you want.
3. **A paused Meta campaign.** Conveyor builds the campaign from your own template. Nothing goes live until you press activate.

The listing writer and the image workers run as local command-line tools on your own Claude and ChatGPT plans, so these steps need no API key. Your keys stay in the macOS Keychain, and the server listens only on `127.0.0.1`.

## Requirements

- macOS
- [Node.js](https://nodejs.org) 24 or newer
- pnpm 10. Run `corepack enable` once and the version pinned in `package.json` is used automatically.
- exiftool: `brew install exiftool`
- [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in with a Claude plan. It writes the listings.
- [Codex CLI](https://github.com/openai/codex), signed in with a ChatGPT plan. It generates the images and is the backup listing writer.

## Install

```sh
git clone https://github.com/Bernardo-Braga/Conveyor.git
cd Conveyor
corepack enable
pnpm install
```

Sign in to both command-line tools with your plan, not an API key:

```sh
claude auth login     # choose your Claude.ai account
codex login           # choose "Sign in with ChatGPT"
```

Conveyor removes every API key from these tools' environment before starting them, so they always run on your plan login.

## Get your keys and IDs

You add everything below in the app under **Settings**. Keys go in the **Keys** panel and IDs in the **Accounts** panel. Each service has a **Test** button in the **Connections** panel.

| Service | Needed for | Required |
|---|---|---|
| RapidAPI | Importing supplier links | Yes |
| Shopify | Creating the product draft | Yes |
| Meta | Launching campaigns | Yes, to launch |
| OpenAI API | Backup image engine | Optional |
| Claude API | A third listing writer | Optional |

### RapidAPI (supplier data)

1. Create an account at [rapidapi.com](https://rapidapi.com).
2. Subscribe to **AliExpress DataHub** (`aliexpress-datahub.p.rapidapi.com`). To import 1688 links as well, subscribe to **1688 DataHub** (`1688-datahub.p.rapidapi.com`). Both can use the same RapidAPI app.
3. Open either API's **Playground** and copy the `X-RapidAPI-Key` value. You can also find it under **Apps → your app → Authorization**.
4. In Conveyor, paste it into **Settings → Keys → RapidAPI key**.

Each product costs one request. Under **Settings → Import quota**, set the pause threshold to fit your plan's monthly allowance.

### Shopify (product drafts)

Conveyor uses a custom app from the Shopify Dev Dashboard with the client-credentials grant. The app must belong to the same organization as your store.

1. Go to the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard) and create an app.
2. Create a version with these Admin API scopes and release it:
   `read_products`, `write_products`, `read_publications`, `write_publications`, `write_files`
3. Install the app on your store.
4. Open the app's **Settings** page and copy the **Client ID** and **Client secret**.
5. In Conveyor:
   - put the **Client ID** and **Client secret** in **Settings → Keys**,
   - put your store's `.myshopify.com` domain in **Settings → Accounts → Shopify store domain**,
   - press **Test** next to Shopify.

### Meta (campaigns)

You need a Meta Business portfolio that owns your ad account, Facebook Page and pixel.

1. **App.** At [developers.facebook.com](https://developers.facebook.com/apps), create an app of type **Business** and add the **Marketing API** product.
2. **System user.** In [Business Settings](https://business.facebook.com/settings) → **Users → System users**, add a system user (Admin is simplest). Under **Assign assets**, give it your ad account, Page and pixel.
3. **Token.** Still on the system user, press **Generate new token**, choose your app, and grant these permissions:
   `ads_management`, `ads_read`, `business_management`, `pages_read_engagement`.
   Paste the token into **Settings → Keys → Meta access token**.
4. **IDs.** Fill in **Settings → Accounts**:
   - **Meta ad account ID**: in Ads Manager, the account switcher or the `act=` value in the URL. Enter it as `act_1234567890`.
   - **Meta Page ID**: on your Page, **About → Page transparency**, or Business Settings → **Accounts → Pages**.
   - **Instagram account ID**: Business Settings → **Accounts → Instagram accounts**.
   - **Pixel ID**: Events Manager → **Data sources**.
   - **Test ad account ID** (optional): a separate ad account, used only by `pnpm meta:test-launch`.
5. **App secret (optional).** Only needed if your app has **Require app secret** turned on. Copy it from **App settings → Basic → App secret** into **Settings → Keys → Meta app secret**.

Everything Conveyor creates on Meta starts **paused**. A campaign only goes live when you activate it from the Launch tab.

### OpenAI API (optional backup image engine)

If Codex hits your ChatGPT plan's limit or fails twice on a batch, Conveyor can finish the remaining images through the OpenAI Images API (`gpt-image-2`).

1. Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). The organization needs access to `gpt-image-2`, which may require verifying the organization.
2. Paste it into **Settings → Keys → OpenAI API key**. The hand-off is on by default, and you can turn it off under **Settings → Image engine**. You can also make OpenAI the main engine there.

### Claude API (optional)

This is not needed if you use Claude Code. A key from the [Claude Console](https://console.anthropic.com/settings/keys) adds a third listing writer, and it is never the default. Paste it into **Settings → Keys → Claude API key**.

## Run

```sh
pnpm start
```

Then open <http://127.0.0.1:4310>. This builds the web app and serves it together with the API. Restart it after pulling changes.

For development with hot reload, run `pnpm dev`. The web app is at <http://127.0.0.1:5173>, and the API runs on port 4310.

To start Conveyor automatically when you log in, run `pnpm start-at-login install`, or use the switch under **Settings → Maintenance**. Run `pnpm start-at-login uninstall` to remove it.

## First run

1. **Settings.** Add your keys and IDs and press **Test** for each connection.
2. **Settings → Import.** Check the pricing multiplier, margin, shipping estimate and currency rate. Optionally, describe your store's brand voice and standing rules for the listing writer.
3. **Templates.** Import a Meta campaign template (JSON). `fixtures/templates/` has two examples: one CBO, one ABO.
4. **Line.** Paste a supplier link. You can add a short focus for the listing first. Conveyor imports the product, writes the listing and creates the Shopify draft.
5. **Studio.** Generate creatives, then approve or reject them (`A` approves, `X` rejects).
6. **Launch.** Choose the template, the creatives and this launch's settings (name, dates, audience, budget), run the checks, and launch. The campaign is created paused. Activate it when you're ready.

The **Requests** tab shows every outside request Conveyor has made, by day, service and product.

## Where your data lives

- **App data:** `~/Library/Application Support/Conveyor/data`. This holds the database, product folders, image worker folders, templates and backups. Set `CONVEYOR_DATA_DIR` to use another folder.
- **Keys:** the macOS Keychain, under the service name `Conveyor`. They are never written to the database, logs, backups or the browser.
- **Backups:** **Settings → Maintenance → Back up now** writes a zip of the database, templates and product folders, without keys. The ten newest are kept.

## Scripts

| Command | What it does |
|---|---|
| `pnpm start` | Builds the web app and serves the app at `http://127.0.0.1:4310`. |
| `pnpm dev` | Runs the server and the Vite dev server with hot reload. |
| `pnpm build` | Builds the web app into `apps/web/dist`. |
| `pnpm test` | Runs all tests. Tests never call an outside service or start a CLI. |
| `pnpm typecheck` | Runs TypeScript in strict mode across all packages. |
| `pnpm lint` | Runs ESLint. |
| `pnpm db:generate` | Generates a Drizzle migration after a change to `apps/server/src/db/schema.ts`. |
| `pnpm start-at-login install\|uninstall\|status` | Manages the login item. |
| `pnpm meta:test-launch [--template ashworth\|whitcombe\|both] [--keep] [--dry-run]` | Creates a paused campaign in the test ad account, reads it back and deletes it. `--dry-run` checks everything with no requests. |
| `pnpm writer:smoke [--writer claude_code\|codex\|both]` | Writes a listing from a fixture with the local writers. Uses your plans, with no API requests. |
| `pnpm codex:smoke [--runs N --timeout S]` | Runs a Codex image-generation test on your ChatGPT plan. |
| `pnpm capture:fixtures <aliexpress link> <1688 link>` | Makes 2 RapidAPI requests and saves the responses as test fixtures. |

## Project layout

```
apps/server        Hono API, job worker, SSE, SQLite (Drizzle), Keychain access
apps/web           React + Vite + Tailwind + Radix interface
packages/shared    Zod schemas and types shared by both apps
config/versions.ts Pinned Meta, Shopify, CLI and model versions
fixtures/          Recorded responses and sample templates used by the tests
scripts/           Manual scripts that make live calls
```

## License

[MIT](LICENSE)
