// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**', '**/*.d.ts', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Hard rule 4: keytar is archived; keys live in the Keychain via @napi-rs/keyring.
      'no-restricted-imports': ['error', { paths: [{ name: 'keytar', message: 'Use @napi-rs/keyring.' }] }],
    },
  },
  {
    // Hard rule 1: one HTTP path. Only ledgerClient.ts may call fetch.
    files: ['apps/server/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['apps/server/src/http/ledgerClient.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Outside requests go through http/ledgerClient.ts.' }],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'fetch', message: 'Outside requests go through http/ledgerClient.ts.' },
        { object: 'global', property: 'fetch', message: 'Outside requests go through http/ledgerClient.ts.' },
      ],
      'no-restricted-imports': ['error', { paths: [
        { name: 'keytar', message: 'Use @napi-rs/keyring.' },
        { name: 'undici', message: 'Outside requests go through http/ledgerClient.ts.' },
        { name: 'node-fetch', message: 'Outside requests go through http/ledgerClient.ts.' },
        { name: 'axios', message: 'Outside requests go through http/ledgerClient.ts.' },
        { name: 'node:http', message: 'Outside requests go through http/ledgerClient.ts.' },
        { name: 'node:https', message: 'Outside requests go through http/ledgerClient.ts.' },
        { name: 'http', message: 'Outside requests go through http/ledgerClient.ts.' },
        { name: 'https', message: 'Outside requests go through http/ledgerClient.ts.' },
      ] }],
    },
  },
  {
    // Hard rule 7: exiftool is called with execFile, never a shell.
    files: ['apps/server/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='exec']", message: 'Use execFile, never a shell.' },
        { selector: "CallExpression[callee.name='execSync']", message: 'Use execFile, never a shell.' },
      ],
    },
  },
);
