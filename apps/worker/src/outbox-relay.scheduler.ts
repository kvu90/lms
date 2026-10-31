import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { Interval } from '@nestjs/schedule';
import { asc, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './db/relations';
import { outboxEvents, tenants } from '@lms/db';
import { SpaceDatabaseService } from './db/routing/space-database.service';
import { mapWithConcurrencyLimit } from './db/routing/space-sweep';
import { EventLogWriter } from './event-log-writer.service';
import { TaskLogService } from './task-log.service';
import { tenantAls } from './db/tenant-als';
import {
  OUTBOX_EVENT_QUEUES,
  OUTBOX_EVENT_ROUTES,
  queueNamesOfRoute,
  type OutboxEventJobData,
  type OutboxEventQueueRoutes,
  type OutboxEventQueues,
} from './outbox-event-routes';

type Database = NodePgDatabase<typeof relations>;

type OutboxRow = typeof outboxEvents.$inferSelect;

/**
 * Relay outbox DUY NHẤT của toàn hệ thống, chạy trong tiến trình
 * worker theo lịch 5 giây — đường đóng dấu `publishedAt` production
 * duy nhất.
 *
 * @remarks
 * Flow của một nhịp relay:
 * 1. Quét tối đa `limit` dòng `outbox_events` chưa có `publishedAt`,
 *    theo thứ tự id tăng dần, trong ngữ cảnh platform tường minh
 *    (relay quét xuyên tenant — xem {@link OutboxRelayScheduler.relayTick}).
 * 2. Với từng dòng, theo đúng thứ tự: PHÁT cho phía tiêu thụ trước,
 *    ĐÓNG DẤU sau, PHẢN CHIẾU vào `event_log` cuối cùng.
 *    - Nếu loại sự kiện có trong bảng định tuyến
 *      {@link OUTBOX_EVENT_QUEUE_ROUTES}: bước phát là đẩy một job
 *      BullMQ vào MỌI hàng đợi đích của loại đó (tên job là loại
 *      sự kiện, `jobId` là id của dòng outbox, dữ liệu job là toàn
 *      bộ dòng — xem {@link OutboxEventJobData}). Mọi đích đều đẩy
 *      thành công mới được coi là đã phát: loại có nhiều consumer
 *      (fan-out) chỉ được đóng dấu khi mọi consumer đều đã có job
 *      của dòng.
 *    - Nếu loại sự kiện chưa có trong bảng định tuyến: consumer của
 *      nó chưa chuyển sang worker nên chưa thuộc phạm vi phát job;
 *      phía tiêu thụ của dòng vẫn là các consumer polling đọc trực
 *      tiếp bảng outbox theo watermark `seq` riêng, và bước phát
 *      hoàn tất tại chính lần đóng dấu dưới đây như đường
 *      production hiện hành.
 * 3. Đóng dấu: ghi `publishedAt` cho dòng. Dấu này nghĩa là "relay
 *    đã phát sự kiện cho phía tiêu thụ" — KHÔNG phải dấu hoàn thành
 *    xử lý: relay không chờ consumer/handler nào xử lý xong, và
 *    không consumer nào được dựa vào `publishedAt` để kết luận sự
 *    kiện đã được xử lý xong (mỗi consumer tự theo dõi tiến độ xử
 *    lý của mình).
 * 4. Phản chiếu dòng đã phát vào `event_log` qua `EventLogWriter`
 *    (observer logstore duy nhất; writer tự nuốt lỗi của nó nên
 *    phản chiếu không bao giờ làm đổi ngữ nghĩa phát).
 *
 * Lượt quét theo trung tâm (issue #582): sau lượt kho chung ở
 * trên, mỗi nhịp còn quét thêm outbox của từng trung tâm ở KHO
 * RIÊNG — danh sách lấy từ sổ đăng ký qua
 * `SpaceDatabaseService.listRegisteredSpaces`, bỏ qua trung tâm
 * đã `closed` (kho có thể đã dỡ). Mỗi trung tâm được quét trong
 * một phiên theo trung tâm của khung định tuyến
 * (`withSpaceDatabase`), với đúng flow phát → đóng dấu → phản
 * chiếu như trên nhưng mọi thao tác đều ở kho của chính trung
 * tâm đó; consumer nhận job mang slug của trung tâm và mở đúng
 * kho qua `SpaceJobRunner`. Các lượt theo trung tâm chạy song
 * song với trần đồng thời cấu hình được
 * (`SPACE_SWEEP_CONCURRENCY`, mặc định 3) — mỗi lượt đang chạy
 * giữ pool của một kho riêng mở, trần này là một phần của ngân
 * sách kết nối của cụm; bên trong MỘT trung tâm, thứ tự phát
 * vẫn tuần tự theo id như kho chung. Trung tâm bị đình chỉ
 * (`suspended`) vẫn được quét: đình chỉ chặn traffic nghiệp vụ
 * ở API, còn outbox là đường nền — sự kiện đã ghi của trung tâm
 * vẫn phải tới được consumer của nó.
 *
 * Bất biến và hành vi khi lỗi:
 * - `publishedAt` không bao giờ xuất hiện trước khi bước phát của
 *   dòng hoàn tất: đẩy job thất bại (ví dụ Redis lỗi) thì dòng
 *   KHÔNG được đóng dấu, KHÔNG được phản chiếu, nhịp relay dừng
 *   ngay tại dòng đó (các dòng sau giữ nguyên thứ tự chờ) và lỗi
 *   được ghi vào `task_log` như một nhịp thất bại; dòng được phát
 *   lại ở nhịp relay sau.
 * - Tính idempotent / at-least-once: tiến trình sập sau khi đẩy job
 *   mà trước khi đóng dấu thì nhịp sau phát lại cùng dòng; `jobId`
 *   bằng id dòng outbox khiến BullMQ trả lại job đã có thay vì tạo
 *   job trùng, nên phía hàng đợi vẫn đúng một job cho một dòng —
 *   NHƯNG chỉ trong cửa sổ hàng đợi còn lưu giữ job theo chính sách
 *   `removeOnComplete` / `removeOnFail` hiện hành. Job đã bị dọn
 *   khỏi hàng đợi thì lần phát lại tạo job mới cho cùng dòng đó, và
 *   khi đó hàng rào chống tác dụng phụ lần hai là tính idempotent
 *   của processor theo `outboxId` (processor tự ghi dấu đã xử lý
 *   theo id dòng và bỏ qua lần xử lý trùng — xem
 *   `outbox-event-routes.ts`).
 * - Nhịp không phát được dòng nào thì không ghi `task_log` để tránh
 *   nhiễu 5 giây; nhịp có phát hoặc có lỗi thì ghi một dòng.
 * - Lỗi của lượt quét MỘT trung tâm (kho không mở được, phát job
 *   lỗi giữa lượt của trung tâm đó) chỉ làm hỏng lượt của trung
 *   tâm đó: nhịp ghi `task_log` trạng thái `failed` kèm slug của
 *   các trung tâm lỗi và KHÔNG ném lại — phần kho chung và các
 *   trung tâm khác đã phát xong giữ nguyên dấu của chúng, lượt
 *   của trung tâm lỗi được thử lại ở nhịp sau (các dòng chưa đóng
 *   dấu của nó vẫn nằm chờ trong kho của nó).
 * - Không đọc được sổ đăng ký thì toàn bộ lượt theo trung tâm bị
 *   bỏ qua ở nhịp này, nhưng nhịp vẫn ghi `task_log` trạng thái
 *   `failed` với thông điệp phân biệt (không lẫn với nhịp không
 *   có trung tâm nào) — sự cố control plane kéo dài không bị che
 *   bởi nhịp `success` giả của lượt kho chung; lượt kho chung
 *   không bị ảnh hưởng và các dòng chưa đóng dấu được thử lại ở
 *   nhịp sau.
 *
 * Side-effect của một nhịp: đẩy job BullMQ (với loại đã định tuyến),
 * ghi cột `publishedAt` của `outbox_events`, chèn dòng `event_log`
 * qua `EventLogWriter`, ghi `task_log` qua `TaskLogService`.
 */
@Injectable()
export class OutboxRelayScheduler {
  private readonly logger = new Logger(OutboxRelayScheduler.name);

  /** Trần lượt quét outbox theo trung tâm chạy đồng thời ở mỗi nhịp (cấu hình `SPACE_SWEEP_CONCURRENCY`). */
  private readonly sweepConcurrency: number;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly eventLog: EventLogWriter,
    private readonly taskLog: TaskLogService,
    @Inject(OUTBOX_EVENT_ROUTES) private readonly routes: OutboxEventQueueRoutes,
    @Inject(OUTBOX_EVENT_QUEUES) private readonly queues: OutboxEventQueues,
    private readonly spaceDb: SpaceDatabaseService,
    config: ConfigService,
  ) {
    this.sweepConcurrency = config.get<number>('SPACE_SWEEP_CONCURRENCY') ?? 3;
  }

  /**
   * Nhịp relay theo lịch (mỗi 5 giây): phát một lô dòng outbox đang
   * chờ và ghi vết nhịp vào `task_log` nếu nhịp có phát hoặc có lỗi.
   *
   * @remarks
   * TENANT-1 (#196): relay quét outbox XUYÊN tenant — bọc ngữ cảnh
   * platform tường minh để RLS fail-closed không làm mù các sự kiện
   * mang tenant_id (pool gắn GUC theo ALS ở mọi checkout).
   *
   * @returns Không trả giá trị; lỗi của nhịp được ghi `task_log` ở
   * trạng thái `failed` rồi ném lại cho cơ chế lịch xử lý.
   */
  @Interval(5000)
  async relayTick(): Promise<void> {
    return tenantAls.run({ platform: true }, () => this.relayTickInContext());
  }

  private async relayTickInContext(): Promise<void> {
    const startedAt = new Date();
    try {
      const publishedShared = await this.publishPending();
      const centrePass = await this.publishPendingForCentres();
      const published = publishedShared + centrePass.published;
      if (centrePass.registryError !== undefined) {
        // Không đọc được sổ đăng ký: toàn bộ lượt theo trung tâm
        // bị bỏ qua ở nhịp này — ghi failed với thông điệp phân
        // biệt để vận hành thấy sự cố control plane, thay vì để
        // nhịp trôi qua như nhịp không có trung tâm nào (hoặc
        // `success` giả nhờ lượt kho chung).
        await this.taskLog.recordRun(
          'outbox-relay',
          startedAt,
          'failed',
          `centre outbox registry read failed: ${centrePass.registryError}`,
        );
        return;
      }
      if (centrePass.failedSlugs.length > 0) {
        // Lượt của ít nhất một trung tâm lỗi: ghi failed kèm slug
        // để vận hành thấy được, nhưng không ném — phần đã phát
        // của nhịp (kho chung và các trung tâm khác) là sự thật
        // đã hoàn tất, xem bất biến ở mô tả lớp.
        await this.taskLog.recordRun(
          'outbox-relay',
          startedAt,
          'failed',
          `relayed ${published} event(s); centre outbox scan failed for: ${centrePass.failedSlugs.join(', ')}`,
        );
        return;
      }
      if (published > 0) {
        await this.taskLog.recordRun('outbox-relay', startedAt, 'success', `relayed ${published} event(s)`);
      }
    } catch (err) {
      await this.taskLog.recordRun('outbox-relay', startedAt, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Phát một lô dòng outbox đang chờ (chưa có `publishedAt`) theo
   * đúng flow ở mô tả của lớp: phát → đóng dấu → phản chiếu, từng
   * dòng một theo thứ tự id.
   *
   * @param limit Số dòng tối đa xử lý trong lượt này (mặc định 50).
   * @returns Số dòng đã được đóng dấu trong lượt này.
   * @throws Lỗi của bước phát (đẩy job) hoặc của bước đóng dấu ở bất
   * kỳ dòng nào: lượt dừng ngay tại dòng đó, dòng gây lỗi và các
   * dòng sau nó chưa được đóng dấu và sẽ được xử lý lại ở lượt sau.
   */
  async publishPending(limit = 50): Promise<number> {
    return this.publishPendingFrom(this.db, limit);
  }

  /**
   * Lượt quét theo trung tâm của một nhịp: quét outbox của từng
   * trung tâm ở kho riêng (xem mô tả lớp) với trần đồng thời
   * `SPACE_SWEEP_CONCURRENCY`.
   *
   * @param limitPerCentre Số dòng tối đa xử lý cho MỘT trung tâm
   * trong lượt này (mặc định 50, như lượt kho chung).
   * @returns Số dòng đã đóng dấu trên mọi trung tâm, danh sách
   * slug của các trung tâm mà lượt của chúng lỗi (lượt của một
   * trung tâm lỗi không chặn các trung tâm còn lại), và thông
   * điệp lỗi đọc sổ (`registryError`) khi không đọc được sổ đăng
   * ký — trường này chỉ xuất hiện ở đường lỗi đọc sổ, để nhịp
   * relay ghi `task_log` failed phân biệt được với nhịp không có
   * trung tâm nào.
   */
  async publishPendingForCentres(
    limitPerCentre = 50,
  ): Promise<{ published: number; failedSlugs: string[]; registryError?: string }> {
    let spaces;
    try {
      spaces = await this.spaceDb.listRegisteredSpaces();
    } catch (err) {
      // Không đọc được sổ ở nhịp này: bỏ qua lượt theo trung tâm
      // của nhịp này (nhịp sau thử lại) thay vì làm hỏng cả nhịp
      // relay — lượt kho chung không phụ thuộc sổ — NHƯNG trả tín
      // hiệu lỗi riêng để nhịp ghi `task_log` failed phân biệt
      // được, thay vì trôi qua như nhịp không có trung tâm nào.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Không đọc được sổ đăng ký để quét outbox theo trung tâm ở nhịp này: ${message}`,
      );
      return { published: 0, failedSlugs: [], registryError: message };
    }
    const dedicated = spaces.filter((space) => space.storageMode === 'dedicated' && space.status !== 'closed');
    let published = 0;
    const failedSlugs: string[] = [];
    await mapWithConcurrencyLimit(dedicated, this.sweepConcurrency, async (space) => {
      try {
        published += await this.spaceDb.withSpaceDatabase(space.slug, (db) =>
          this.publishPendingFrom(db, limitPerCentre),
        );
      } catch (err) {
        failedSlugs.push(space.slug);
        this.logger.warn(
          `Quét outbox của trung tâm ${space.slug} lỗi ở nhịp này, thử lại ở nhịp sau: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    return { published, failedSlugs };
  }

  /**
   * Thân lượt phát dùng chung cho kho chung và cho từng kho riêng
   * của trung tâm: cùng flow phát → đóng dấu → phản chiếu trên
   * đúng handle `db` được truyền (handle kho chung, hoặc handle
   * của kho trung tâm trong phiên theo trung tâm).
   */
  private async publishPendingFrom(db: Database, limit: number): Promise<number> {
    const pending = await db
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.id))
      .limit(limit);

    const spaceSlugs = await this.resolveSpaceSlugs(db, pending);
    let published = 0;
    for (const row of pending) {
      await this.dispatchRow(row, spaceSlugs.get(row.tenantId ?? '') ?? null);
      await db
        .update(outboxEvents)
        .set({ publishedAt: new Date() })
        .where(eq(outboxEvents.id, row.id));
      // Logstore: phản chiếu sang event_log qua observer duy nhất; việc này
      // không đổi ngữ nghĩa phát hành của relay (writer nuốt lỗi của nó).
      await this.eventLog.record({
        id: row.id, seq: row.seq, aggregate: row.aggregate, type: row.type,
        payload: row.payload as Record<string, unknown> | null, occurredAt: row.occurredAt,
        tenantId: row.tenantId,
      });
      published += 1;
    }
    if (published > 0) {
      this.logger.log(`Relayed ${published} outbox event(s)`);
    }
    return published;
  }

  /**
   * Suy ra slug của trung tâm cho từng tenant có mặt trong lô:
   * một truy vấn duy nhất trên bảng `tenants` CỦA CÙNG KHO chứa
   * các dòng outbox (slug của tenant và slug đăng ký của trung
   * tâm là một — xem `OutboxEventJobData.spaceSlug`). Tenant
   * không còn dòng tương ứng thì sự kiện của nó mang slug null.
   */
  private async resolveSpaceSlugs(db: Database, rows: OutboxRow[]): Promise<Map<string, string>> {
    const tenantIds = [...new Set(rows.map((row) => row.tenantId).filter((id): id is string => !!id))];
    const slugs = new Map<string, string>();
    if (tenantIds.length === 0) return slugs;
    const tenantRows = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds));
    for (const tenant of tenantRows) slugs.set(tenant.id, tenant.slug);
    return slugs;
  }

  /**
   * Bước phát của một dòng: đẩy job BullMQ vào mọi hàng đợi đích
   * của loại sự kiện nếu loại đó đã có trong bảng định tuyến; chưa
   * có thì dòng chưa thuộc phạm vi phát job và bước phát là rỗng
   * (phía tiêu thụ của dòng vẫn đọc trực tiếp bảng outbox như hiện
   * hành). Hàm chỉ resolve khi MỌI đích đã nhận job — mọi lỗi đều
   * ném ra để dòng không bị đóng dấu: phát lại ở nhịp sau an toàn ở
   * các đích đã nhận nhờ `jobId` bằng id dòng outbox (BullMQ trả
   * lại job đã có thay vì tạo job thứ hai), nên bất biến "đóng dấu
   * chỉ sau khi phát thành công" giữ nguyên cả khi fan-out nhiều
   * đích.
   *
   * @param row Dòng outbox đang phát (chưa có `publishedAt` tại thời
   * điểm hàm chạy — job được đẩy trong khi dòng còn chưa có dấu).
   * @param spaceSlug Slug của trung tâm mà tenant của dòng thuộc
   * về, đã suy ra cho cả lô (null khi không xác định được).
   */
  private async dispatchRow(row: OutboxRow, spaceSlug: string | null): Promise<void> {
    const route = this.routes[row.type];
    if (!route) return;
    const data: OutboxEventJobData = {
      outboxId: row.id,
      seq: row.seq,
      aggregate: row.aggregate,
      type: row.type,
      payload: row.payload as Record<string, unknown> | null,
      tenantId: row.tenantId,
      spaceSlug,
      occurredAt: row.occurredAt.toISOString(),
    };
    for (const queueName of queueNamesOfRoute(route)) {
      const queue = this.queues.get(queueName);
      if (!queue) {
        throw new Error(
          `Outbox event type "${row.type}" is routed to queue "${queueName}" but that queue is not registered`,
        );
      }
      // jobId bằng id của dòng outbox (không chứa dấu ':' theo luật của
      // package): phát lại cùng một dòng trong lúc job còn được BullMQ
      // lưu giữ thì không tạo job trùng ở đích đó; ngoài cửa sổ lưu
      // giữ đó, chống trùng tác dụng phụ là việc của processor
      // (idempotent theo outboxId — xem outbox-event-routes.ts).
      await queue.add(row.type, data, { jobId: row.id });
    }
  }
}
