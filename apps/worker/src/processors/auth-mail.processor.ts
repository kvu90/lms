import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import Redis from 'ioredis';
import { renderAuthMail, type AuthMailPayload } from '@lms/contracts';
import { redisConnectionFromUrl } from '../config/env';
import type { OutboxEventJobData } from '../outbox-event-routes';
import { ResendMailService } from '../resend-mail.service';

/**
 * Consumer trên hàng đợi của sự kiện outbox `auth_mail_requested`
 * (issue #517 — consumer đầu tiên của đợt tách issue cha #491 chuyển
 * từ polling phía API sang hàng đợi ở worker).
 *
 * @remarks
 * Flow tổng thể của mail auth sau đợt chuyển đổi:
 * 1. Các callback của Better Auth phía API chỉ GHI dòng outbox
 *    `auth_mail_requested` (payload theo hợp đồng ở `@lms/contracts`)
 *    rồi trả về ngay — không gửi mail trong request.
 * 2. Relay outbox duy nhất ở worker phát dòng đó thành MỘT job trên
 *    hàng đợi `auth-mail` (bảng định tuyến ở `outbox-event-routes.ts`:
 *    tên job là loại sự kiện, `jobId` là id của dòng outbox, dữ liệu
 *    job là toàn bộ dòng — xem {@link OutboxEventJobData}), đóng dấu
 *    `publishedAt` và phản chiếu `event_log`. Dấu `publishedAt` là
 *    dấu ĐÃ PHÁT, không phải dấu hoàn thành xử lý.
 * 3. Processor này nhận job, dựng nội dung mail bằng template dùng
 *    chung {@link renderAuthMail} của `@lms/contracts` và gửi qua
 *    transport Resend phía worker ({@link ResendMailService}) — nội
 *    dung mail và hành vi gửi giữ nguyên như đường consumer polling
 *    phía API trước đây (consumer đó đã gỡ ở cùng issue này).
 *
 * Tính idempotent theo `outboxId` (bất biến trung tâm của
 * processor): cơ chế phát là at-least-once — cùng một sự kiện có
 * thể tới processor nhiều lần (`jobId` của BullMQ chỉ chống trùng
 * trong cửa sổ hàng đợi còn lưu giữ job; job bị thử lại sau lỗi,
 * job được phát lại sau sự cố, hay job mới được tạo cho cùng một
 * dòng ngoài cửa sổ lưu giữ đều là các đường tới lần hai). Trước
 * khi gửi, processor kiểm tra dấu đã xử lý theo `outboxId` ở
 * {@link AuthMailSentMarker}; đã có dấu thì bỏ qua không gửi lại.
 * Dấu được ghi SAU khi transport đã nhận mail (hoặc đã khai báo bỏ
 * qua vì chưa cấu hình) — ghi trước khi gửi sẽ làm mất mail khi lần
 * gửi đó lỗi thật. Hệ quả còn lại, giữ đúng ngữ nghĩa at-least-once
 * của đường cũ: tiến trình sập đúng giữa lúc transport vừa nhận
 * mail mà dấu chưa kịp ghi thì lần xử lý sau có thể gửi trùng một
 * mail — vô hại với cả hai loại mail auth (liên kết reset dùng lại
 * cùng token; mã OTP trùng là cùng một mã).
 *
 * Hành vi theo từng kết quả xử lý một job:
 * - Payload không hợp lệ (thiếu/khác hai loại `kind` đã chốt, thiếu
 *   người nhận): ghi log lỗi và KẾT THÚC job không gửi, không ném
 *   lỗi — payload hỏng vĩnh viễn thì thử lại bao nhiêu lần cũng
 *   hỏng, không được để job độc chặn hàng đợi (đường cũ bỏ qua dòng
 *   theo đúng cách này).
 * - Transport trả `skipped` (chưa cấu hình `RESEND_API_KEY` /
 *   `MAIL_FROM`): môi trường chưa được cấp khoá là trạng thái vận
 *   hành hợp lệ — ghi log cảnh báo, ghi dấu đã xử lý, kết thúc job
 *   như đường cũ coi dòng là đã xử lý.
 * - Transport ném lỗi (mạng/4xx/5xx của Resend): KHÔNG ghi dấu, lỗi
 *   được ném ra để cơ chế thử lại của BullMQ (chính sách job mặc
 *   định của `worker.module.ts`: tối đa 3 lần, giãn cách hàm mũ)
 *   phát lại job; lần thử sau vẫn qua kiểm tra dấu nên không gửi
 *   trùng. Khác đường cũ ở cơ chế thử lại (hàng đợi thay cho bộ đếm
 *   trong tiến trình) và ở chỗ một job hỏng không còn chặn các mail
 *   đứng sau nó trong outbox.
 *
 * Side-effect: gửi mail qua Resend (qua transport phía worker), ghi
 * khoá dấu đã xử lý vào Redis qua {@link AuthMailSentMarker}. Không
 * đọc/ghi DB, không đụng `publishedAt`.
 */

/**
 * Dấu "sự kiện outbox này đã được processor mail auth xử lý xong"
 * theo `outboxId` — bề mặt tối thiểu mà {@link AuthMailProcessor}
 * cần để đạt tính idempotent. Bản cài đặt production là
 * {@link RedisAuthMailSentMarker}; test cấp bản giả trong bộ nhớ.
 */
export interface AuthMailSentMarker {
  /** Sự kiện có `outboxId` này đã được ghi dấu xử lý xong hay chưa. */
  has(outboxId: string): Promise<boolean>;
  /** Ghi dấu sự kiện có `outboxId` này đã xử lý xong. */
  mark(outboxId: string): Promise<void>;
}

/** Khoá tiêm của {@link AuthMailSentMarker} trong `worker.module.ts`. */
export const AUTH_MAIL_SENT_MARKER = 'AUTH_MAIL_SENT_MARKER';

/** Tiền tố khoá Redis của dấu đã xử lý: `lms:auth-mail:sent:<outboxId>`. */
const SENT_MARKER_KEY_PREFIX = 'lms:auth-mail:sent:';

/**
 * Thời gian sống của một dấu đã xử lý: 7 ngày. Mọi cửa sổ phát lại
 * thực tế (thử lại của BullMQ, phát lại của relay sau sự cố) đều
 * tính bằng phút tới giờ, còn bí mật trong mail chỉ sống tối đa 1
 * giờ (liên kết reset) và 5 phút (mã OTP) — dấu sống lâu hơn hẳn
 * mọi cửa sổ đó nhưng vẫn tự dọn để Redis không tích lũy vô hạn
 * theo số sự kiện.
 */
const SENT_MARKER_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Bản cài đặt Redis của {@link AuthMailSentMarker}: mỗi sự kiện đã
 * xử lý là một khoá `lms:auth-mail:sent:<outboxId>` có hạn
 * {@link SENT_MARKER_TTL_SECONDS}. Kết nối Redis tạo lười theo đúng
 * khuôn của `NotificationDeliveryService` (chỉ mở kết nối khi job
 * đầu tiên cần kiểm tra dấu) và đóng khi module huỷ.
 */
@Injectable()
export class RedisAuthMailSentMarker implements AuthMailSentMarker, OnModuleDestroy {
  private readonly logger = new Logger(RedisAuthMailSentMarker.name);
  private client: Redis | null = null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
      this.client = null;
    }
  }

  /** Kết nối Redis tạo lười cho khoá dấu đã xử lý. */
  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis({
        ...redisConnectionFromUrl(this.config.getOrThrow<string>('REDIS_URL')),
      });
      this.client.on('error', (error: Error) => {
        this.logger.warn(`Redis của dấu đã xử lý mail auth lỗi: ${error.message}`);
      });
    }
    return this.client;
  }

  async has(outboxId: string): Promise<boolean> {
    return (await this.redis().get(`${SENT_MARKER_KEY_PREFIX}${outboxId}`)) !== null;
  }

  async mark(outboxId: string): Promise<void> {
    await this.redis().set(`${SENT_MARKER_KEY_PREFIX}${outboxId}`, '1', 'EX', SENT_MARKER_TTL_SECONDS);
  }
}

/** Kết quả xử lý một job của {@link AuthMailProcessor} (để quan sát và kiểm chứng ở test). */
export interface AuthMailProcessResult {
  status:
    /** Mail đã được transport nhận gửi ở lần xử lý này. */
    | 'sent'
    /** Transport bỏ qua vì chưa cấu hình Resend — coi như đã xử lý như đường cũ. */
    | 'skipped'
    /** Sự kiện đã xử lý ở lần trước (có dấu theo `outboxId`) — lần phát lại bị bỏ qua. */
    | 'duplicate'
    /** Payload không hợp lệ — job kết thúc không gửi, không thử lại. */
    | 'invalid';
}

/**
 * Processor của hàng đợi `auth-mail`: nhận job sự kiện
 * `auth_mail_requested` do relay outbox phát, dựng nội dung bằng
 * template dùng chung và gửi qua transport Resend phía worker.
 * Xem mô tả ở đầu file cho flow đầy đủ, bất biến idempotent theo
 * `outboxId` và hành vi theo từng kết quả.
 */
@Processor('auth-mail')
export class AuthMailProcessor extends WorkerHost {
  private readonly logger = new Logger(AuthMailProcessor.name);

  constructor(
    private readonly mailer: ResendMailService,
    @Inject(AUTH_MAIL_SENT_MARKER) private readonly sentMarker: AuthMailSentMarker,
  ) {
    super();
  }

  /**
   * Xử lý MỘT job mail auth.
   *
   * @param job Job do relay phát: `job.data` là toàn bộ dòng outbox
   * đã chuẩn hoá; định danh chống trùng là `job.data.outboxId`.
   * @returns Kết quả xử lý theo {@link AuthMailProcessResult}.
   * @throws Lỗi của transport Resend (và lỗi đọc/ghi dấu Redis) —
   * ném ra để BullMQ thử lại job theo chính sách mặc định; dấu đã
   * xử lý chưa được ghi ở lần lỗi nên lần thử lại không gửi trùng.
   */
  async process(job: Job<OutboxEventJobData>): Promise<AuthMailProcessResult> {
    const data = job.data;
    const parsed = (data?.payload ?? null) as AuthMailPayload | null;
    if (!parsed || (parsed.kind !== 'password_reset' && parsed.kind !== 'email_otp') || !parsed.to) {
      this.logger.error(
        `Payload mail auth không hợp lệ, bỏ qua job của dòng outbox ${data?.outboxId}: ${JSON.stringify(parsed)?.slice(0, 200)}`,
      );
      return { status: 'invalid' };
    }

    // Hàng rào idempotent: sự kiện đã xử lý xong ở một lần phát
    // trước (thử lại, phát lại sau sự cố, job mới ngoài cửa sổ lưu
    // giữ của BullMQ) thì không gửi lại.
    if (await this.sentMarker.has(data.outboxId)) {
      this.logger.log(
        `Mail auth của dòng outbox ${data.outboxId} đã xử lý ở lần phát trước — bỏ qua lần phát lại.`,
      );
      return { status: 'duplicate' };
    }

    const message = renderAuthMail(parsed);
    const result = await this.mailer.send(message);
    if (result.status === 'skipped') {
      this.logger.warn(
        `Mail auth tới ${parsed.to} (loại ${parsed.kind}) không được gửi: ${result.reason} — môi trường chưa cấu hình Resend.`,
      );
    }
    // Chỉ ghi dấu SAU khi transport đã nhận (hoặc đã khai báo bỏ
    // qua): lỗi gửi thật ở trên đã ném ra trước điểm này nên không
    // bao giờ có dấu cho một mail chưa gửi.
    await this.sentMarker.mark(data.outboxId);
    return { status: result.status };
  }
}
