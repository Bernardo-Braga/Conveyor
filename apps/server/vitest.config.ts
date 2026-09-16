import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      CONVEYOR_ENV: 'test',
      CONVEYOR_SECRETS: 'memory',
    },
  },
});
