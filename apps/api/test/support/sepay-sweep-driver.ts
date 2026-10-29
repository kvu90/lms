import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  OutboxWriterService,
  PaymentsRepository,
  PlanEntitlementsService,
  SepayMatchingService,
} from '@lms/payments';
import { SepayMatchingScheduler } from '../../../worker/src/sepay-matching.scheduler';
import { TenantAwarePool } from '../../../worker/src/db/tenant-pool';
import { relations } from '../../../worker/src/db/relations';
import { WorkerEnrolOutboxService } from '../../../worker/src/worker-enrol-outbox.service';
import { WorkerPaidClassEnrolActivationService } from '../../../worker/src/worker-paid-class-enrol-activation.service';
import { WorkerPaidEnrolActivationService } from '../../../worker/src/worker-paid-enrol-activation.service';
import { WorkerPaymentSettlementService } from '../../../worker/src/worker-payment-settlement.service';

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
 * Vòng đời: pool dựng lười ở lần dẫn đầu tiên của file spec và được
 * đóng ở `afterAll` của file đó qua `closeSepaySweepDriver()` — mỗi
 * file e2e chạy trong module registry riêng nên singleton này là
 * theo file, không dùng chung qua các file.
 */
let scheduler: SepayMatchingScheduler | null = null;
let pool: TenantAwarePool | null = null;

function getScheduler(): SepayMatchingScheduler {
  if (!scheduler) {
    pool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle({ client: pool, relations });
    const repo = new PaymentsRepository(db);
    const writer = new OutboxWriterService(db);
    const plans = new PlanEntitlementsService(repo);
    const enrolOutbox = new WorkerEnrolOutboxService(writer);
    const matching = new SepayMatchingService(
      repo,
      writer,
      new WorkerPaidEnrolActivationService(db, enrolOutbox),
      new WorkerPaidClassEnrolActivationService(db, enrolOutbox),
      plans,
      new WorkerPaymentSettlementService(db, repo, plans, enrolOutbox),
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

/** Đóng pool của cầu dẫn — gọi ở `afterAll` của file spec dùng nó. */
export async function closeSepaySweepDriver(): Promise<void> {
  scheduler = null;
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}
