import { z } from 'zod';

/**
 * Names of the keys kept in the macOS Keychain. Values never leave the server.
 * The browser only ever learns whether a key is set, and the last four characters.
 */
export const SecretName = z.enum([
  'rapidapi_key',
  'claude_api_key',
  'openai_api_key',
  'shopify_client_id',
  'shopify_client_secret',
  'meta_access_token',
  /** Optional. When set, every Meta request carries appsecret_proof, which apps with "Require app secret" demand. */
  'meta_app_secret',
]);
export type SecretName = z.infer<typeof SecretName>;
export const SECRET_NAMES = SecretName.options;

export const SecretStatus = z.object({
  name: SecretName,
  set: z.boolean(),
  /** Last four characters, or null. Never more than that. */
  hint: z.string().max(4).nullable(),
  updatedAt: z.string().nullable(),
});
export type SecretStatus = z.infer<typeof SecretStatus>;

export const SetSecretBody = z.object({
  value: z.string().min(1).max(4096),
});
