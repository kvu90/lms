import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { tenantAls } from '../db/tenant-als';
import type { OutboxEventJobData } from '../outbox-event-routes';
import {
  GuardianDigestHandlerService,
  type GuardianDigestDuePayload,
  type GuardianOverdueAlertPayload,
} from '../guardian-digest-handler.service';

/**
 * Kiểm tra hình dạng payload của sự kiện `guardian_digest_due` —
 * đúng bộ kiểm tra consumer phía API trước đây vẫn áp trước khi gọi
 * handler: đủ năm trường chuỗi bắt buộc và `kind` thuộc
 * {weekly, daily}; thiếu/sai thì sự kiện bị bỏ qua lặng lẽ.
 */
function isDigestDuePayload(payload: unknown): payload is GuardianDigestDuePayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.guardianUserId === 'string'
    && typeof p.studentUserId === 'string'
    && typeof p.digestId === 'string'
    && typeof p.windowStart === 'string'
    && typeof p.windowEnd === 'string'
    && (p.kind === 'weekly' || p.kind === 'daily');
}

/**
 * Kiểm tra hình dạng payload của sự kiện `guardian_overdue_alert` —
 * đúng bộ kiểm tra consumer phía API trước đây: bốn trường chuỗi
 * định danh bắt buộc (guardianUserId, studentUserId, digestId,
 * cmId); các trường nội dung còn lại do handler dùng theo payload
 * đã chốt của lượt quét.
 */
function isOverdueAlertPayload(payload: unknown): payload is GuardianOverdueAlertPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.guardianUserId === 'string'
    && typeof p.studentUserId === 'string'
    && typeof p.digestId === 'string'
    && typeof p.cmId === 'string';
}

/**
 * Consumer phía worker của hai sự kiện digest phụ huynh
 * (`guardian_digest_due`, `guardian_overdue_alert`) — thay consumer
 * polling `GuardianDigestConsumer` phía API ở issue con #518 của
 * #491: relay outbox duy nhất định tuyến hai loại này vào hàng đợi
 * `guardian-digest-events` với jobId = outboxId, processor này chỉ
 * kiểm tra hình dạng payload rồi uỷ cho
 * {@link GuardianDigestHandlerService}.
 *
 * Ngữ nghĩa lỗi giữ đúng consumer phía API: digest là kênh phụ nên
 * lỗi của MỘT sự kiện chỉ ghi cảnh báo rồi hoàn thành job — không
 * ném ra để BullMQ thử lại. Lý do không thử lại: nửa phát thông báo
 * của handler không an toàn khi phát lại giữa chừng (chưa có chốt
 * chống trùng bền ở tầng thông báo), còn chốt bền thật của nghiệp
 * vụ là vết lượt `guardian_digests` — lượt đã rời `queued` thì mọi
 * lần xử lý sau đều là no-op, nên một job được phát lại (kể cả bởi
 * relay khi jobId chưa kịp dedupe) không sinh thông báo trùng.
 *
 * Ngữ cảnh tenant: chạy trong ngữ cảnh platform tường minh như
 * consumer phía API vẫn chạy toàn bộ nhịp của nó — handler tự kiểm
 * cổng liên kết giám hộ và gắn tenant của liên kết lên mọi dòng nó
 * ghi (thông báo, dispatch log, sự kiện audit).
 */
@Processor('guardian-digest-events')
export class GuardianDigestEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(GuardianDigestEventsProcessor.name);

  constructor(private readonly handler: GuardianDigestHandlerService) {
    super();
  }

  /**
   * Xử lý một job sự kiện digest: trả `{ handled: true }` khi sự
   * kiện thuộc hai loại digest và payload đúng hình dạng (handler
   * đã chạy — kết quả nghiệp vụ nằm ở vết lượt); các trường hợp còn
   * lại (payload sai hình dạng, handler ném lỗi, loại lạ lạc vào
   * hàng đợi) đều hoàn thành lặng lẽ với `handled: false` theo ngữ
   * nghĩa nuốt lỗi của consumer phía API trước đây.
   */
  async process(job: Job<OutboxEventJobData>): Promise<{ handled: boolean }> {
    return tenantAls.run({ platform: true }, async () => {
      const { type, payload } = job.data;
      try {
        if (type === 'guardian_digest_due') {
          if (!isDigestDuePayload(payload)) return { handled: false };
          await this.handler.processDigestDue(payload);
          return { handled: true };
        }
        if (type === 'guardian_overdue_alert') {
          if (!isOverdueAlertPayload(payload)) return { handled: false };
          await this.handler.processOverdueAlert(payload);
          return { handled: true };
        }
        return { handled: false };
      } catch (error) {
        this.logger.warn(`Xử lý sự kiện digest ${type} lỗi: ${(error as Error).message}`);
        return { handled: false };
      }
    });
  }
}
