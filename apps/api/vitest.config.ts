import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: {
      // Cách ly suite: API dùng DB riêng lms_test_api, worker dùng
      // lms_test_worker (xem apps/worker/vitest.config.ts) — hai suite
      // chạy song song trong CI không còn giẫm lên dữ liệu toàn cục của
      // nhau (outbox backlog, event_log...). LMS_TEST_DATABASE_URL vẫn
      // ghi đè được khi cần trỏ cả hai vào một DB riêng theo worktree.
      DATABASE_URL: process.env.LMS_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/lms_test_api',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret-at-least-16-chars',
      NODE_ENV: 'test',
      PORT: '3100',
      // Secret xác thực webhook thanh toán cho gateway 'manual' (H1,
      // #134): spec webhook đọc cùng giá trị này qua process.env để gắn
      // header `x-payment-webhook-secret`. Chỉ là khoá test công khai.
      PAYMENT_WEBHOOK_SECRET: 'test-only-payment-webhook-secret-0123456789',
      // Bộ test e2e bắn hàng nghìn request từ một IP: nới hạn mức để
      // rate limit không chặn test; hành vi 429 có spec riêng với hạn
      // mức thấp (test/e2e/platform/platform-hardening.e2e-spec.ts).
      RATE_LIMIT_PER_MINUTE: '1000000',
      RATE_LIMIT_AUTH_PER_MINUTE: '1000000',
    },
    // Ba tầng test chạy tách nhau bằng Vitest projects: unit (spec cạnh
    // mã nguồn trong src), int (test/integration — spec gọi trực tiếp
    // service), e2e (test/e2e — spec lái qua HTTP). Mỗi project khai
    // include tường minh neo thư mục + hậu tố của tầng mình, vì pattern
    // khám phá mặc định của Vitest không nhận `.e2e-spec.ts` lẫn
    // `.int-spec.ts` — thiếu khai là test âm thầm không chạy. Các tuỳ
    // chọn dùng chung (env, timeout, fileParallelism) khai ở gốc để
    // project con kế thừa. Chạy riêng từng tầng: pnpm test:unit /
    // test:int / test:e2e; script test chạy đủ cả ba project.
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      { test: { name: 'int', include: ['test/integration/**/*.int-spec.ts'] } },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e-spec.ts'],
        },
      },
    ],
  },
});
