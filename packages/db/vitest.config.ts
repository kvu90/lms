import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
