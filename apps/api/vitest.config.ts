import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: {
      // DB test riêng cho từng worktree qua LMS_TEST_DATABASE_URL;
      // không đặt thì giữ mặc định lms_test như trước (CI không đổi).
      DATABASE_URL: process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'test',
      PORT: '3100',
      // Bộ test e2e bắn hàng nghìn request từ một IP: nới hạn mức để
      // rate limit không chặn test; hành vi 429 có spec riêng với hạn
      // mức thấp (test/platform-hardening.e2e-spec.ts).
      RATE_LIMIT_PER_MINUTE: '1000000',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000000',
    },
  },
});
