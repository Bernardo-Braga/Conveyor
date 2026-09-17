import { listingJsonSchema } from '@conveyor/shared';

let cached: string | null = null;

/** The JSON Schema string handed to both CLIs. Built once; it never varies by product. */
export function listingJsonSchemaString(): string {
  cached ??= JSON.stringify(listingJsonSchema());
  return cached;
}
