/**
 * Harness boot `WorkerModule` bằng role DB thường cho các spec worker
 * (lát 2 của issue #294 — tổng quát hoá harness lát 1 ở
 * `test/ordinary-role.ts` từ ca mẫu dựng processor trực tiếp sang mọi
 * spec boot module).
 *
 * Vấn đề nền: trước lát này, mọi spec boot `WorkerModule` đều nhận
 * kết nối Drizzle do `DrizzleModule` của module tự dựng từ
 * `DATABASE_URL` của suite — user `postgres` superuser. Superuser có
 * BYPASSRLS nên lỗi "quên gắn ngữ cảnh tenant" trong processor /
 * scheduler vô hình trong test, trong khi production chạy bằng role
 * ứng dụng không BYPASSRLS và RLS fail-closed nuốt dữ liệu lặng lẽ
 * (đúng lớp lỗi của issue #292, mới chỉ được khoá ở một ca mẫu dựng
 * processor trực tiếp tại `class-enrol-reconcile-rls.spec.ts`).
 *
 * Cơ chế của harness (đúng đặc tả lát 2 trong issue #294):
 *
 *   1. Dựng role thường qua {@link ensureOrdinaryRole} của harness
 *      lát 1 (idempotent, cấp quyền tối thiểu trên schema `public`).
 *   2. Boot `WorkerModule` bằng testing module có
 *      `overrideProvider(getDrizzleToken())` trỏ sang một kết nối
 *      Drizzle mới: `TenantAwarePool` đăng nhập bằng role thường
 *      trên cùng DB test của suite. Mọi processor / scheduler /
 *      service của module — kể cả các scheduler nền chạy chen giữa
 *      các bước dựng dữ liệu — đều xử lý qua kết nối này, đúng hình
 *      dạng kết nối production.
 *   3. Fixture và đọc kiểm chứng đi qua `adminDb`: kết nối quản trị
 *      (superuser, pool thường không gắn GUC) trên cùng DB — đúng
 *      vai của đường seed production và bảo đảm khẳng định của spec
 *      quan sát được toàn bộ dữ kiện, không bị chính RLS che.
 *   4. Handle Kysely kho chung (`spaceDb.routedKysely`) được gắn
 *      lại sau init sang cùng pool role thường của `ordinaryDb`:
 *      factory của `WorkerModule` đã gắn nó vào pool superuser của
 *      module trong lúc init, nên harness phải gắn lại — nếu không
 *      các processor/service đã chuyển sang Kysely sẽ lặng lẽ chạy
 *      trên pool superuser và vô hiệu hoá bất biến RLS của harness
 *      đúng như lỗi mà lát 2 này sinh ra để chặn. Instance Kysely
 *      không được `destroy()` riêng — vòng đời của nó đi theo pool
 *      (xem `SpaceDatabaseService`), `close()` chỉ đóng hai pool.
 *
 * Bất biến:
 *   - Khẳng định nghiệp vụ của spec không đổi khi chuyển sang
 *     harness: chỉ môi trường role của phần xử lý thay đổi, đường
 *     nạp fixture và đường đọc kiểm chứng giữ nguyên khả năng quan
 *     sát như khi spec còn chạy một kết nối superuser duy nhất.
 *   - Pool của hai kết nối do harness sở hữu; `close()` đóng testing
 *     context trước rồi mới đóng hai pool (context đóng sau cùng ở
 *     các lượt trước không còn giữ tham chiếu tới pool đã đóng).
 *   - Harness không đụng `worker.smoke.spec.ts` và không đổi cách ly
 *     DB của suite (`lms_test_worker` riêng, tách khỏi `lms_test_api`).
 */
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Test } from '@nestjs/testing';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createCentreKysely } from '@lms/db';
import { relations } from '../../src/db/relations';
import { TenantAwarePool } from '../../src/db/tenant-pool';
import { SpaceDatabaseService } from '../../src/db/routing/space-database.service';
import { WorkerModule } from '../../src/worker.module';
import { adminDatabaseUrl, ensureOrdinaryRole, ordinaryRoleUrl } from './ordinary-role';

/** Bộ kết nối + context mà {@link bootWorkerModuleAsOrdinaryRole} trả cho spec. */
export interface OrdinaryWorkerModuleHarness {
  /** Testing context của `WorkerModule` đã boot bằng role thường. */
  context: INestApplicationContext;
  /**
   * Kết nối quản trị (superuser) trên cùng DB test: spec dùng để nạp
   * fixture và đọc kiểm chứng — tương đương khả năng quan sát của kết
   * nối module duy nhất mà spec dùng trước khi chuyển sang harness.
   */
  adminDb: NodePgDatabase<typeof relations>;
  /**
   * Kết nối role thường mà module đang chạy qua token Drizzle. Spec
   * chỉ cần tới kết nối này khi tự dựng processor bằng tay ngoài DI
   * (mẫu của `notification-email.spec.ts`) — khi đó processor tự dựng
   * phải nhận đúng kết nối này mới là phần xử lý dưới RLS.
   */
  ordinaryDb: NodePgDatabase<typeof relations>;
  /**
   * Khung định tuyến của module sau khi harness đã gắn lại handle
   * Kysely kho chung sang pool role thường (mục 4 của docblock
   * đầu file). Spec tự dựng processor/service đã chuyển sang
   * Kysely bằng tay phải truyền đúng service này (không phải
   * `ordinaryDb` Drizzle) mới là phần xử lý dưới RLS.
   */
  spaceDb: SpaceDatabaseService;
  /** Đóng testing context rồi đóng hai pool của harness. */
  close: () => Promise<void>;
}

/**
 * Boot `WorkerModule` với kết nối Drizzle bị thay bằng role thường.
 *
 * Flow: lấy URL quản trị của suite → dựng role thường idempotent →
 * dựng `adminDb` (pool thường) và `ordinaryDb` (`TenantAwarePool`
 * đăng nhập role thường) → tạo testing module với
 * `overrideProvider(getDrizzleToken()).useValue(ordinaryDb)` → init
 * context (scheduler nền của module bắt đầu chạy bằng role thường
 * ngay từ thời điểm này).
 *
 * @returns Harness gồm context đã init, hai kết nối và hàm đóng.
 * @throws Error khi `DATABASE_URL` chưa được đặt (suite chạy ngoài
 *   vitest config) — ném từ {@link adminDatabaseUrl} của harness lát 1.
 */
export async function bootWorkerModuleAsOrdinaryRole(): Promise<OrdinaryWorkerModuleHarness> {
  const adminUrl = adminDatabaseUrl();
  await ensureOrdinaryRole(adminUrl);

  const adminPool = new Pool({ connectionString: adminUrl });
  const adminDb = drizzle({ client: adminPool, relations });

  const ordinaryPool = new TenantAwarePool({ connectionString: ordinaryRoleUrl(adminUrl) });
  const ordinaryDb = drizzle({ client: ordinaryPool, relations });

  const context = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(getDrizzleToken())
    .useValue(ordinaryDb)
    .compile();
  await context.init();

  // Gắn lại handle Kysely kho chung sang pool role thường (mục 4):
  // factory của module đã gắn nó vào pool superuser trong lúc init.
  const spaceDb = context.get(SpaceDatabaseService);
  spaceDb.bindSharedKysely(createCentreKysely(ordinaryPool));

  return {
    context,
    adminDb,
    ordinaryDb,
    spaceDb,
    close: async () => {
      await context.close();
      await ordinaryPool.end();
      await adminPool.end();
    },
  };
}
