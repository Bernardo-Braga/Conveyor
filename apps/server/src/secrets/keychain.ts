import { eq } from 'drizzle-orm';
import type { Entry as KeyringEntry } from '@napi-rs/keyring';
import { SecretName, SECRET_NAMES, type SecretStatus } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { secretMeta } from '../db/schema.ts';

/**
 * Where keys live. The only implementation used outside tests is the macOS Keychain
 * via @napi-rs/keyring. Values are read by the server and never leave it.
 */
export interface SecretStore {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

export class KeychainStore implements SecretStore {
  private entryClass: typeof KeyringEntry | null = null;

  constructor(private readonly service: string) {}

  private async entry(name: SecretName) {
    if (!this.entryClass) {
      const mod = await import('@napi-rs/keyring');
      this.entryClass = mod.Entry;
    }
    return new this.entryClass(this.service, name);
  }

  async get(name: SecretName): Promise<string | null> {
    const e = await this.entry(name);
    try {
      return e.getPassword() ?? null;
    } catch {
      return null;
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    const e = await this.entry(name);
    e.setPassword(value);
  }

  async delete(name: SecretName): Promise<void> {
    const e = await this.entry(name);
    try {
      e.deletePassword();
    } catch {
      /* already gone */
    }
  }
}

/** Tests only. Never used when CONVEYOR_SECRETS is `keychain`. */
export class MemoryStore implements SecretStore {
  private readonly values = new Map<SecretName, string>();
  async get(name: SecretName) {
    return this.values.get(name) ?? null;
  }
  async set(name: SecretName, value: string) {
    this.values.set(name, value);
  }
  async delete(name: SecretName) {
    this.values.delete(name);
  }
}

/**
 * The server-side facade. Tracks `updatedAt` in SQLite (metadata only) and
 * answers the browser with set/unset plus the last four characters, never more.
 */
export class Secrets {
  constructor(
    private readonly store: SecretStore,
    private readonly db: Db,
  ) {}

  async get(name: SecretName): Promise<string | null> {
    return this.store.get(name);
  }

  async require(name: SecretName): Promise<string> {
    const v = await this.store.get(name);
    if (!v) throw new MissingSecretError(name);
    return v;
  }

  async set(name: SecretName, value: string): Promise<void> {
    SecretName.parse(name);
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Empty key');
    await this.store.set(name, trimmed);
    const updatedAt = new Date().toISOString();
    this.db.insert(secretMeta).values({ name, updatedAt }).onConflictDoUpdate({ target: secretMeta.name, set: { updatedAt } }).run();
  }

  async delete(name: SecretName): Promise<void> {
    await this.store.delete(name);
    this.db.delete(secretMeta).where(eq(secretMeta.name, name)).run();
  }

  /** Every current secret value, for redaction. Never returned to callers outside the server. */
  async allValues(): Promise<string[]> {
    const values = await Promise.all(SECRET_NAMES.map((n) => this.store.get(n)));
    return values.filter((v): v is string => !!v);
  }

  async status(): Promise<SecretStatus[]> {
    const meta = new Map(this.db.select().from(secretMeta).all().map((r) => [r.name, r.updatedAt]));
    return Promise.all(
      SECRET_NAMES.map(async (name) => {
        const v = await this.store.get(name);
        return { name, set: !!v, hint: v ? v.slice(-4) : null, updatedAt: meta.get(name) ?? null };
      }),
    );
  }
}

export class MissingSecretError extends Error {
  constructor(public readonly secretName: SecretName) {
    super(`Missing key: ${LABELS[secretName]}. Add it under Settings, Connections.`);
  }
}

export const LABELS: Record<SecretName, string> = {
  rapidapi_key: 'RapidAPI key',
  claude_api_key: 'Claude API key',
  openai_api_key: 'OpenAI API key',
  shopify_client_id: 'Shopify client ID',
  shopify_client_secret: 'Shopify client secret',
  meta_access_token: 'Meta access token',
};
