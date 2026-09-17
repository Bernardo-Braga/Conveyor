/**
 * Pinned versions of every outside service and tool Conveyor talks to.
 * Change these deliberately, with a live check, and update PLAN.md.
 */
export const VERSIONS = {
  /** Meta Marketing API (Graph) version used for every Meta request. */
  metaApi: 'v26.0',
  /** Shopify Admin GraphQL API version. */
  shopifyAdminApi: '2026-07',
  /** Codex CLI version the worker pool, the smoke test and the fallback listing writer were checked against. */
  codexCli: '0.154.0',
  /** Claude Code version the listing writer's flags were checked against. */
  claudeCodeCli: '2.1.273',
  /** Claude API version header. */
  anthropicVersion: '2023-06-01',
  /** Local CLI writers. These run on the user's own plans, so no key and no API version apply. */
  writers: {
    /** `claude -p --model`. An alias tracks the current model of that tier. */
    claudeCodeModel: 'sonnet',
  },
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
