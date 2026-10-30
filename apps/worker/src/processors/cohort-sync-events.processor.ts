import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SpaceJobRunner } from '../db/routing/space-job-runner';
import { CohortSyncService } from '../cohort-sync.service';
import type { OutboxEventJobData } from '../outbox-event-routes';

/** Hai loại sự kiện thành viên cohort mà consumer này xử lý. */
export const COHORT_SYNC_EVENT_TYPES = ['cohort_member_added', 'cohort_member_removed'] as const;

/**
 * Kiểm tra hình dạng payload của sự kiện thành viên cohort — đúng bộ
 * kiểm tra consumer polling phía API trước đây vẫn áp trước khi gọi
 * handler: đủ hai trường chuỗi định danh KHÔNG RỖNG (`cohortId`,
 * `userId`); thiếu, sai kiểu hoặc rỗng thì sự kiện bị bỏ qua lặng
 * lẽ, không ném lỗi để BullMQ thử lại một payload không bao giờ
 * xử lý được.
 */
function isCohortMemberPayload(payload: unknown): payload is { cohortId: string; userId: string } {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.cohortId === 'string' && p.cohortId.length > 0
    && typeof p.userId === 'string' && p.userId.length > 0;
}

/**
 * Consumer phía worker của hai sự kiện thành viên cohort
 * (`cohort_member_added`, `cohort_member_removed`) — thay consumer
 * polling `CohortSyncOutboxConsumer` phía API ở issue con #528 của
 * #519 (đợt tách #491): relay outbox duy nhất định tuyến hai loại
 * này vào hàng đợi `cohort-sync-events` với `jobId` bằng id dòng
 * outbox, processor này chỉ kiểm tra hình dạng payload rồi uỷ cho
 * {@link CohortSyncService} — host phía worker của bề mặt vật chất
 * hoá cohort dùng chung (`@lms/enrol`, issue con #527).
 *
 * @remarks
 * Flow: relay phát job → processor chạy toàn bộ job trong ngữ cảnh
 * platform (bề mặt tự gắn tenant tường minh cho từng dòng nó ghi
 * qua các lõi dùng chung) → uỷ đúng một điểm vào vật chất hoá theo
 * `type` của job. Processor KHÔNG mang watermark `seq` riêng và
 * KHÔNG dựng cơ chế theo dõi tiến độ riêng, theo đúng quyết định
 * chốt cho issue này: tính idempotent được bảo đảm hai tầng —
 * (1) relay chống trùng job theo id dòng outbox (`jobId`) trong cửa
 * sổ hàng đợi còn lưu giữ job, và (2) guard theo trạng thái hiện
 * tại của `cohort_members` trong chính bề mặt (sự kiện phát lại
 * muộn không ghi danh cho người đã rời, cũng không đình chỉ người
 * đã vào lại; ghi danh lại người đã có chỉ cập nhật dòng sẵn có,
 * không phát thêm `user_enrolled`; rời ở chế độ rút gặp dòng đã rút
 * hoặc đã xoá thì bỏ qua).
 *
 * Ngữ nghĩa lỗi giữ đúng tính chất thử lại được của bề mặt: lỗi của
 * bề mặt hoặc hạ tầng được ném ra để BullMQ thử lại theo cấu hình
 * hàng đợi (tối đa 3 lần, giãn cách hàm mũ từ 1 giây — xem
 * `worker.module.ts`); các thao tác của bề mặt chạy trong
 * transaction hoặc neo vào trạng thái hiện tại nên thử lại an toàn
 * cho trạng thái bền. Job cạn cả 3 lần thử thì rơi vào khoảng trống
 * khôi phục chung của mọi hàng đợi outbox (hạng mục nền tảng của
 * repo mới, đã phân xử ở #520/#521); lưới sửa lệch còn lại là job
 * đối soát ghi danh lớp (`class-enrol-reconcile`) chạy định kỳ.
 * Loại sự kiện lạ lạc vào hàng đợi và payload sai hình dạng hoàn
 * thành lặng lẽ với `handled: false` — không ném lỗi, vì thử lại
 * cũng không xử lý được.
 *
 * Giới hạn còn lại được ghi rõ: phát lại một sự kiện rời ở chế độ
 * đình chỉ sau khi ghi danh đã SUSPENDED sẽ cập nhật lại cùng trạng
 * thái và phát thêm một dòng `user_enrolment_suspended` — trạng thái
 * ghi danh bền không đổi, và loại sự kiện này hiện chưa có consumer
 * nào nên dòng trùng không gây tác dụng phụ nghiệp vụ nào; đây là
 * hệ quả của phát ít-nhất-một-lần khi đường đình chỉ của bề mặt
 * phát sự kiện trong transaction riêng sau khi cập nhật trạng thái.
 * Việc thay đổi bề mặt để chặn dòng trùng này thuộc về bề mặt dùng
 * chung, không thuộc phạm vi issue này.
 */
@Processor('cohort-sync-events')
export class CohortSyncEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(CohortSyncEventsProcessor.name);

  constructor(
    private readonly cohortSync: CohortSyncService,
    private readonly jobRunner: SpaceJobRunner,
  ) {
    super();
  }

  /**
   * Xử lý một job sự kiện thành viên cohort.
   *
   * @param job Job do relay phát, dữ liệu là dòng outbox đã chuẩn hoá.
   * @returns `handled: true` khi sự kiện thuộc hai loại cohort và
   * payload đúng hình dạng (bề mặt đã chạy); `handled: false` với
   * loại sự kiện lạ hoặc payload sai hình dạng.
   * @throws Lỗi của bề mặt hoặc hạ tầng được truyền ra để BullMQ thử lại job.
   */
  async process(job: Job<OutboxEventJobData>): Promise<{ handled: boolean }> {
    return this.jobRunner.runForJob(job.data, async () => {
      const { type, payload } = job.data;
      if (type === 'cohort_member_added' || type === 'cohort_member_removed') {
        if (!isCohortMemberPayload(payload)) {
          this.logger.warn(`Bỏ qua sự kiện cohort ${type}: payload thiếu cohortId/userId dạng chuỗi.`);
          return { handled: false };
        }
        if (type === 'cohort_member_added') {
          await this.cohortSync.materializeMemberAdded(payload);
        } else {
          await this.cohortSync.materializeMemberRemoved(payload);
        }
        return { handled: true };
      }
      return { handled: false };
    });
  }
}
