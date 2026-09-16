/**
 * Scrubs anything that looks like a key from text destined for the ledger, logs,
 * error messages or the browser. Known secret values are removed exactly; common
 * key shapes are removed by pattern as a second line of defence.
 */
const SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Claude
  /sk-(?:proj-)?[A-Za-z0-9_-]{8,}/g, // OpenAI
  /shp(?:at|ca|ss|pa|ua)_[A-Fa-f0-9]{8,}/g, // Shopify tokens and secrets
  /EAA[A-Za-z0-9]{16,}/g, // Meta user / system-user tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs
];
/** `access_token=…`, `api_key: …`, `"client_secret": "…"`: keep the key name, drop the value. */
const KEY_VALUE = /(access_token|api[_-]?key|client_secret|x-rapidapi-key|password)(=|:\s*|"\s*:\s*")[^&\s",]{4,}/gi;

export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const s of knownSecrets) {
    if (s.length >= 4) out = out.split(s).join('[redacted]');
  }
  out = out.replace(KEY_VALUE, '$1$2[redacted]');
  for (const re of SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

/** Host and path only. Query strings and fragments can carry tokens, so they are never stored. */
export function safeUrl(input: string | URL): string {
  try {
    const u = input instanceof URL ? input : new URL(input);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid url]';
  }
}

/** Removes token-like keys from an object tree (imported JSON, settings echoes). */
const TOKEN_KEYS = /(token|secret|api[_-]?key|password|authorization)/i;
export function dropTokenKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropTokenKeys) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (TOKEN_KEYS.test(k)) continue;
      out[k] = dropTokenKeys(v);
    }
    return out as T;
  }
  return value;
}
