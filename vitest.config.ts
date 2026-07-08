import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setupEnv.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/env.ts',
        'src/events/**',
        'src/services/auth.ts',
        'src/logger.ts',
        'src/types.ts',
        'src/db/schema.ts',
        'src/domain/types.ts',
      ],
    },
  },
});
