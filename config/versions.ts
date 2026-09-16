/**
 * Pinned versions of every outside service and tool Conveyor talks to.
 * Change these deliberately, with a live check, and update PLAN.md.
 */
export const VERSIONS = {
  /** Meta Marketing API (Graph) version used for every Meta request. */
  metaApi: 'v26.0',
  /** Shopify Admin GraphQL API version. */
  shopifyAdminApi: '2026-07',
  /** Codex CLI version the worker pool and the smoke test were checked against. */
  codexCli: '0.154.0',
  /** Claude API version header. */
  anthropicVersion: '2023-06-01',
  /** Model IDs. */
  models: {
    /** Writes and translates listings (one call per product). */
    listing: 'claude-sonnet-5',
    /** Optional creative check and unknown-template mapping. */
    check: 'claude-sonnet-5',
    /** OpenAI backup image engine. */
    openaiImage: 'gpt-image-2',
  },
} as const;

export type Versions = typeof VERSIONS;
