import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'test',
    },
  },
});
