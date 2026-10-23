import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      // Cách ly suite: worker dùng DB riêng lms_test_worker, API dùng
      // lms_test_api (xem apps/api/vitest.config.ts) — hai suite chạy
      // song song trong CI không còn giẫm lên dữ liệu toàn cục của nhau
      // (relay outbox đọc backlog chung là ca đã vỡ). LMS_TEST_DATABASE_URL
      // vẫn ghi đè được khi cần trỏ cả hai vào một DB riêng theo worktree.
      DATABASE_URL: process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test_worker',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'test',
      FILE_STORAGE_DIR: '/tmp/lms-worker-test-files',
    },
  },
});
