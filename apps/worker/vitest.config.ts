import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    // Tách tầng chạy bằng Vitest projects: mỗi tầng khai include tường
    // minh neo đúng thư mục + hậu tố của tầng đó, vì pattern khám phá
    // mặc định của Vitest không nhận hậu tố `.int-spec.ts`. Các tuỳ
    // chọn dùng chung (timeout, env) khai ở gốc để project con kế thừa.
    // - unit: spec cạnh nguồn trong `src`, hậu tố `.spec.ts`.
    // - int: spec tích hợp trong `test/integration/<module>`, hậu tố
    //   `.int-spec.ts` (hậu tố và tầng integration là quy định riêng
    //   của dự án, không phải quy ước của NestJS/Vitest).
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      {
        test: {
          name: 'int',
          include: [
            'test/integration/**/*.int-spec.ts',
            // Chuyển tiếp: file dưới đây thuộc tầng integration nhưng
            // đang được sửa trong PR #451 nên chưa di chuyển vào
            // `test/integration/activity/`; dòng này giữ nó còn chạy
            // trong project int và phải được gỡ khi file đó được
            // chuyển về đúng tầng ở việc nối tiếp.
            'test/activity/activity-due-reminder.spec.ts',
          ],
        },
      },
    ],
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
