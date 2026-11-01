import 'reflect-metadata';
import { and, asc, gt, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outboxEvents } from '@lms/db';
import {
  OutboxWriterService,
  PaymentsRepository,
  PlanEntitlementsService,
  SepayMatchingService,
} from '@lms/payments';
import type { ConfigService } from '@nestjs/config';
import { CohortSyncService } from '../../../worker/src/cohort-sync.service';
import { SepayMatchingScheduler } from '../../../worker/src/sepay-matching.scheduler';
import { SpaceDatabaseService } from '../../../worker/src/db/routing/space-database.service';
import { TenantAwarePool } from '../../../worker/src/db/tenant-pool';
import { relations } from '../../../worker/src/db/relations';
import { WorkerEnrolOutboxService } from '../../../worker/src/worker-enrol-outbox.service';
import { WorkerPaidClassEnrolActivationService } from '../../../worker/src/worker-paid-class-enrol-activation.service';
import { WorkerPaidEnrolActivationService } from '../../../worker/src/worker-paid-enrol-activation.service';
import { WorkerPaymentSettlementService } from '../../../worker/src/worker-payment-settlement.service';
import { WorkerPaymentSpaceScope } from '../../../worker/src/worker-payment-space-scope.service';

/**
 * Cầu dẫn nhịp quét matching SePay ở worker cho các suite e2e
 * payments (issue con #539 của #522).
 *
 * Bối cảnh: trước #539, tiến trình API trong `createTestApp()` vừa
 * ghi sự kiện IPN vừa chạy consumer `setInterval` quét matching, nên
 * các spec chỉ cần thăm dò (poll) trạng thái rồi khớp. Từ #539,
 * consumer đã gỡ khỏi API — tiến trình API trong test không còn quét
 * nữa — nên các spec phải TỰ dẫn nhịp quét của worker, nếu không
 * mọi lần chờ `waitPaymentStatus` đều timeout.
 *
 * Cách dẫn: dựng ĐÚNG ngăn xếp production của worker bằng `new`
 * (không qua Nest, không boot WorkerModule — e2e shard chỉ build
 * `@lms/api`, không có tiến trình worker chạy kèm): tay cầm Drizzle
 * trên `TenantAwarePool` của worker (gắn GUC theo ALS như module
 * thật), repository + writer + service của `@lms/payments`, ba
 * adapter cổng của worker, `SepayMatchingService`, rồi
 * `SepayMatchingScheduler`. Mỗi vòng thăm dò của spec gọi một nhịp
 * `sweepTick()` rồi mới đọc trạng thái — giữ nguyên hình thăm dò
 * cũ, chỉ thêm bước dẫn nhịp vào đầu mỗi vòng.
 *
 * Vì sao import thẳng code production của worker thay vì dựng một
 * bản quét riêng cho test: import thẳng thì spec khẳng định đúng
 * đường production (cùng scheduler, cùng adapter, cùng matching);
 * một bản dựng riêng cho test sẽ chỉ chứng minh bản test chạy được,
 * không chứng minh worker chạy được. Nhịp 1 giây theo lịch
 * (`@Interval`) không nằm trong phạm vi dẫn này — nó được ghim ở
 * tầng worker (`sepay-matching-sweep.int-spec.ts` boot module thật
 * và chờ nhịp tự chạy).
 *
 * Nhịp đồng bộ cohort (hệ quả của #550 × #539): từ #528, consumer
 * đồng bộ cohort chạy ở worker, còn consumer polling phía API đã gỡ
 * khỏi tiến trình API — nên trong e2e không còn ai tiêu thụ các dòng
 * `cohort_member_added`/`cohort_member_removed` mà nhịp quét matching
 * vừa ghi. `driveCohortSync()` đóng đúng vai consumer cũ: quét bảng
 * outbox theo watermark riêng của file, gọi bề mặt vật chất hoá dùng
 * chung qua `CohortSyncService` của worker cho từng dòng, bỏ qua riêng
 * lẻ dòng lỗi như consumer cũ (vòng chờ của spec sẽ timeout nếu lệch
 * còn tồn tại). Watermark khởi từ 0 — bề mặt vật chất hoá đã
 * idempotent theo trạng thái hiện tại của `cohort_members` nên phát
 * lại lịch sử cũ là an toàn (đúng mẫu neo lại về 0 khi DB dựng lại
 * của consumer cũ).
 *
 * Vòng đời: pool dựng lười ở lần dẫn đầu tiên của file spec và được
 * đóng ở `afterAll` của file đó qua `closeSepaySweepDriver()` — mỗi
 * file e2e chạy trong module registry riêng nên singleton này là
 * theo file, không dùng chung qua các file.
 */
let scheduler: SepayMatchingScheduler | null = null;
let pool: TenantAwarePool | null = null;
let sharedDb: NodePgDatabase<typeof relations> | null = null;
let cohortSync: CohortSyncService | null = null;
let cohortWatermark = 0;

function getSharedDb(): NodePgDatabase<typeof relations> {
  if (!sharedDb) {
    pool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL });
    sharedDb = drizzle({ client: pool, relations });
  }
  return sharedDb;
}

function getScheduler(): SepayMatchingScheduler {
  if (!scheduler) {
    const db = getSharedDb();
    const repo = new PaymentsRepository(db);
    const writer = new OutboxWriterService(db);
    const plans = new PlanEntitlementsService(repo);
    const enrolOutbox = new WorkerEnrolOutboxService(writer);
    // Điểm phân giải không gian theo payment của worker (tiền điều
    // kiện Phần B của issue #587 — hạng mục 2): cầu dẫn không cấu
    // hình control plane (`ConfigService` rỗng, không gọi
    // `onModuleInit`) nên mọi phân giải cho `not_configured` và
    // kích hoạt chạy platform ở kho chung — đúng hành vi của cầu
    // dẫn trước hạng mục này. Handle kho chung THÔ được gắn vào
    // khung định tuyến đúng như factory của module worker làm lúc
    // khởi động.
    const spaceDatabase = new SpaceDatabaseService({ get: () => undefined } as unknown as ConfigService);
    spaceDatabase.bindSharedDatabase(db);
    const spaceScope = new WorkerPaymentSpaceScope(db, spaceDatabase);
    const matching = new SepayMatchingService(
      repo,
      writer,
      new WorkerPaidEnrolActivationService(db, enrolOutbox, spaceScope),
      new WorkerPaidClassEnrolActivationService(db, enrolOutbox, spaceScope),
      plans,
      new WorkerPaymentSettlementService(db, repo, plans, enrolOutbox, spaceScope),
    );
    scheduler = new SepayMatchingScheduler(matching);
  }
  return scheduler;
}

/**
 * Dẫn một nhịp quét matching của worker (tối đa 20 sự kiện đang chờ
 * một nhịp, đúng hợp đồng nhịp production).
 */
export async function driveSepaySweep(): Promise<void> {
  await getScheduler().sweepTick();
}

/** Các loại sự kiện cohort mà nhịp đồng bộ phải vật chất hoá — đúng tập của consumer polling phía API đã gỡ (issue #528). */
const COHORT_SYNC_TYPES = ['cohort_member_added', 'cohort_member_removed'] as const;

/**
 * Dẫn một nhịp đồng bộ cohort của worker (tối đa 200 sự kiện một
 * nhịp, đúng hợp đồng nhịp của consumer cũ): tiêu thụ mọi dòng
 * cohort mới sau watermark rồi vật chất hoá qua bề mặt dùng chung.
 */
export async function driveCohortSync(): Promise<void> {
  if (!cohortSync) cohortSync = new CohortSyncService(getSharedDb());
  const rows = await getSharedDb()
    .select({ seq: outboxEvents.seq, type: outboxEvents.type, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(gt(outboxEvents.seq, cohortWatermark), inArray(outboxEvents.type, [...COHORT_SYNC_TYPES])))
    .orderBy(asc(outboxEvents.seq))
    .limit(200);
  for (const row of rows) {
    try {
      const payload = row.payload as Record<string, unknown>;
      const cohortId = typeof payload.cohortId === 'string' ? payload.cohortId : null;
      const userId = typeof payload.userId === 'string' ? payload.userId : null;
      if (cohortId && userId) {
        if (row.type === 'cohort_member_added') await cohortSync.materializeMemberAdded({ cohortId, userId });
        else if (row.type === 'cohort_member_removed') await cohortSync.materializeMemberRemoved({ cohortId, userId });
      }
    } catch (error) {
      // Bỏ qua riêng lẻ như consumer cũ: một sự kiện lỗi không được chặn các sự kiện sau.
      console.warn(`Nhịp đồng bộ cohort bỏ qua seq=${row.seq} (${row.type}): ${(error as Error).message}`);
    }
    cohortWatermark = row.seq;
  }
}

/** Đóng pool của cầu dẫn — gọi ở `afterAll` của file spec dùng nó. */
export async function closeSepaySweepDriver(): Promise<void> {
  scheduler = null;
  cohortSync = null;
  cohortWatermark = 0;
  sharedDb = null;
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}
