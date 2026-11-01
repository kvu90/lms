import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tọa độ cụm PostgreSQL chuẩn của môi trường test (khớp service
    // postgres:18.6 của CI): spec khói chỉ cần MỘT kết nối quản trị
    // để dựng database riêng của nó, và DATABASE_URL cấp job không
    // tới được tiến trình test qua turbo nên phải ghim tại đây —
    // cùng cách vitest.config của apps/api ghim DATABASE_URL của
    // nó. Biến LMS_DB_TEST_ADMIN_URL (đọc trong spec) ghi đè khi
    // cần trỏ tới cụm khác, ví dụ cụm local ở cổng riêng.
    env: {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/postgres',
    },
    // Suite của package chạm database thật (spec khói dựng DB từ
    // rỗng): chạy tuần tự theo file để các suite không giẫm lên
    // database/role test dùng chung.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Hai tầng test khai `include` tường minh neo thư mục + hậu tố
    // của tầng mình qua projects (pattern khám phá mặc định của
    // Vitest không nhận `.int-spec.ts` — xem AGENTS.md ở gốc repo):
    // unit là spec `.spec.ts` cạnh mã nguồn trong `src`; int là
    // spec `.int-spec.ts` (hiện là spec khói của harness
    // test-support, chạy trên database thật). Project unit loại
    // tường minh các file `.int-spec.ts` vì hậu tố đó cũng khớp
    // pattern `.spec.ts`.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.int-spec.ts'],
        },
      },
      { test: { name: 'int', include: ['src/**/*.int-spec.ts'] } },
    ],
  },
});
