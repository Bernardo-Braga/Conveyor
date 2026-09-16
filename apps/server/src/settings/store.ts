import { eq } from 'drizzle-orm';
import { SETTINGS_SECTIONS, type SettingsFor, type SettingsSection } from '@conveyor/shared';
import type { Db } from '../db/index.ts';
import { settings } from '../db/schema.ts';
import { dropTokenKeys } from '../http/redact.ts';

/** Settings are stored in SQLite as validated JSON, one row per section. */
export class SettingsStore {
  constructor(private readonly db: Db) {}

  get<S extends SettingsSection>(section: S): SettingsFor<S> {
    const schema = SETTINGS_SECTIONS[section];
    const row = this.db.select().from(settings).where(eq(settings.section, section)).get();
    return schema.parse(row?.json ?? {}) as SettingsFor<S>;
  }

  /** Validates, drops token-like keys, stores and returns the normalised value. */
  set<S extends SettingsSection>(section: S, value: unknown): SettingsFor<S> {
    const schema = SETTINGS_SECTIONS[section];
    const parsed = schema.parse(dropTokenKeys(value)) as SettingsFor<S>;
    const updatedAt = new Date().toISOString();
    this.db
      .insert(settings)
      .values({ section, json: parsed, updatedAt })
      .onConflictDoUpdate({ target: settings.section, set: { json: parsed, updatedAt } })
      .run();
    return parsed;
  }
}
