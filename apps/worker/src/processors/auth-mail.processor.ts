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
 * dòng ngoài cửa sổ lưu giữ đều là các đường tới lần hai), và hai
 * lượt xử lý còn có thể chạy ĐỒNG THỜI (job bị nhận xử lý lại sau
 * khi mất khoá BullMQ trong lúc lượt trước chưa xong, hai tiến
 * trình worker chồng lấn khi triển khai). Vì vậy hàng rào không
 * phải kiểm tra-rồi-ghi dấu ở hai bước rời nhau (hai lượt đồng
 * thời cùng qua được bước kiểm tra rồi cùng gửi), mà là CHIẾM dấu
 * nguyên tử theo `outboxId` ở {@link AuthMailSentMarker} TRƯỚC
 * khi gửi: đúng một lượt chiếm được dấu và đi tiếp tới transport;
 * mọi lượt còn lại — phát lại tuần tự hay đồng thời — đều thấy dấu
 * đã có và bỏ qua. Dấu chiếm được giữ nguyên sau khi gửi xong và
 * đóng luôn vai trò dấu đã xử lý. Nếu lần gửi đó THẤT BẠI, dấu
 * được NHẢ ra trước khi lỗi ném tiếp cho BullMQ thử lại, nên lượt
 * thử lại chiếm lại được dấu và gửi được — một lần gửi lỗi không
 * khoá chết sự kiện. Giới hạn còn lại, ghi nhận đúng ngữ nghĩa
 * at-least-once (không tuyên bố đúng-một-lần tuyệt đối với dịch
 * vụ mail bên ngoài): tiến trình sập SAU khi đã chiếm dấu mà
 * TRƯỚC khi gửi xong thì dấu vẫn đứng tới hết hạn, các lần phát
 * lại trong cửa sổ đó bị coi là đã xử lý và mail đó không được
 * gửi trong cửa sổ hạn của dấu.
 *
 * Hành vi theo từng kết quả xử lý một job:
 * - Payload không hợp lệ (thiếu/khác hai loại `kind` đã chốt, thiếu
 *   người nhận): ghi log lỗi và KẾT THÚC job không gửi, không ném
 *   lỗi — payload hỏng vĩnh viễn thì thử lại bao nhiêu lần cũng
 *   hỏng, không được để job độc chặn hàng đợi (đường cũ bỏ qua dòng
 *   theo đúng cách này).
 * - Transport trả `skipped` (chưa cấu hình `RESEND_API_KEY` /
 *   `MAIL_FROM`): môi trường chưa được cấp khoá là trạng thái vận
 *   hành hợp lệ — ghi log cảnh báo, giữ dấu đã chiếm làm dấu đã xử
 *   lý, kết thúc job như đường cũ coi dòng là đã xử lý.
 * - Transport ném lỗi (mạng/4xx/5xx của Resend): NHẢ dấu đã chiếm
 *   rồi ném lỗi ra để cơ chế thử lại của BullMQ (chính sách job
 *   mặc định của `worker.module.ts`: tối đa 3 lần, giãn cách hàm
 *   mũ) phát lại job; lần thử sau chiếm lại dấu nên vẫn gửi được
 *   và chỉ gửi đúng một lần khi thành công. Khác đường cũ ở cơ chế
 *   thử lại (hàng đợi thay cho bộ đếm trong tiến trình) và ở chỗ
 *   một job hỏng không còn chặn các mail đứng sau nó trong outbox.
 *
 * Side-effect: gửi mail qua Resend (qua transport phía worker),
 * chiếm/nhả khoá dấu theo `outboxId` trên Redis qua
 * {@link AuthMailSentMarker}. Không đọc/ghi DB, không đụng
 * `publishedAt`.
 */

/**
 * Dấu chiếm/đã xử lý của sự kiện outbox theo `outboxId` — bề mặt
 * tối thiểu mà {@link AuthMailProcessor} cần để đạt tính
 * idempotent kể cả khi hai lượt xử lý chạy đồng thời. Bản cài đặt
 * production là {@link RedisAuthMailSentMarker} (chiếm bằng lệnh
 * Redis nguyên tử); test cấp bản giả trong bộ nhớ có cùng ngữ
 * nghĩa nguyên tử.
 */
export interface AuthMailSentMarker {
  /** Sự kiện có `outboxId` này đang có dấu (đang được một lượt giữ, hoặc đã xử lý xong) hay chưa. */
  has(outboxId: string): Promise<boolean>;
  /**
   * Chiếm dấu theo `outboxId` một cách NGUYÊN TỬ: trả `true` cho
   * đúng một lượt gọi khi dấu chưa tồn tại (lượt đó sở hữu việc xử
   * lý sự kiện), trả `false` cho mọi lượt gọi khác trong khi dấu
   * còn đứng. Dấu chiếm có cùng hạn sống như dấu đã xử lý trước
   * đây — giữ nguyên sau khi gửi xong thì nó chính là dấu đã xử
   * lý.
   */
  claim(outboxId: string): Promise<boolean>;
  /**
   * Nhả dấu đã chiếm theo `outboxId` (xoá khoá): chỉ dùng khi lần
   * xử lý giữ dấu kết thúc bằng lỗi gửi, để lượt thử lại của hàng
   * đợi chiếm lại được dấu và gửi được.
   */
  release(outboxId: string): Promise<void>;
}

/** Khoá tiêm của {@link AuthMailSentMarker} trong `worker.module.ts`. */
export const AUTH_MAIL_SENT_MARKER = 'AUTH_MAIL_SENT_MARKER';

/** Tiền tố khoá Redis của dấu đã xử lý: `lms:auth-mail:sent:<outboxId>`. */
const SENT_MARKER_KEY_PREFIX = 'lms:auth-mail:sent:';

/**
 * Thời gian sống của một dấu (chiếm và đã xử lý): 7 ngày. Mọi cửa
 * sổ phát lại thực tế (thử lại của BullMQ, phát lại của relay sau
 * sự cố) đều tính bằng phút tới giờ, còn bí mật trong mail chỉ
 * sống tối đa 1 giờ (liên kết reset) và 5 phút (mã OTP) — dấu
 * sống lâu hơn hẳn mọi cửa sổ đó nhưng vẫn tự dọn để Redis không
 * tích lũy vô hạn theo số sự kiện.
 */
const SENT_MARKER_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Bản cài đặt Redis của {@link AuthMailSentMarker}: mỗi sự kiện là
 * một khoá `lms:auth-mail:sent:<outboxId>` có hạn
 * {@link SENT_MARKER_TTL_SECONDS}; chiếm dấu bằng `SET ... NX`
 * (lệnh nguyên tử phía Redis — đúng một lượt trong mọi lượt đồng
 * thời nhận được khoá). Kết nối Redis tạo lười theo đúng khuôn
 * của `NotificationDeliveryService` (chỉ mở kết nối khi job đầu
 * tiên cần chiếm dấu) và đóng khi module huỷ.
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

  async claim(outboxId: string): Promise<boolean> {
    const result = await this.redis().set(
      `${SENT_MARKER_KEY_PREFIX}${outboxId}`,
      '1',
      'EX',
      SENT_MARKER_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  async release(outboxId: string): Promise<void> {
    await this.redis().del(`${SENT_MARKER_KEY_PREFIX}${outboxId}`);
  }
}

/** Kết quả xử lý một job của {@link AuthMailProcessor} (để quan sát và kiểm chứng ở test). */
export interface AuthMailProcessResult {
  status:
    /** Mail đã được transport nhận gửi ở lần xử lý này. */
    | 'sent'
    /** Transport bỏ qua vì chưa cấu hình Resend — coi như đã xử lý như đường cũ. */
    | 'skipped'
    /** Sự kiện đã có dấu theo `outboxId` (đã xử lý ở lần trước, hoặc lượt đồng thời khác đang giữ dấu) — lần này bị bỏ qua. */
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
   * @throws Lỗi của transport Resend — ném ra để BullMQ thử lại
   * job theo chính sách mặc định, nhưng CHỈ sau khi đã nhả dấu đã
   * chiếm, nên lần thử lại chiếm lại được dấu và gửi được (không
   * bị dấu của lần lỗi chặn). Lỗi khi chiếm dấu (Redis) ném ra
   * TRƯỚC khi bất kỳ mail nào được gửi ở lần xử lý đó. Sau một lần
   * gửi thành công không còn thao tác ghi dấu nào nữa (dấu chiếm
   * trước khi gửi chính là dấu đã xử lý), nên không tồn tại đường
   * lỗi ghi dấu sau gửi khiến lần thử lại gửi trùng.
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

    // Hàng rào idempotent: chiếm dấu NGUYÊN TỬ theo outboxId
    // trước khi gửi. Không chiếm được nghĩa là sự kiện đã xử lý
    // xong ở một lần phát trước, hoặc một lượt đồng thời đang giữ
    // dấu và chịu trách nhiệm gửi — cả hai trường hợp lần này đều
    // bỏ qua, không gửi.
    if (!(await this.sentMarker.claim(data.outboxId))) {
      this.logger.log(
        `Mail auth của dòng outbox ${data.outboxId} đã có dấu xử lý — bỏ qua lần phát lại hoặc lượt đồng thời.`,
      );
      return { status: 'duplicate' };
    }

    try {
      const message = renderAuthMail(parsed);
      const result = await this.mailer.send(message);
      if (result.status === 'skipped') {
        this.logger.warn(
          `Mail auth tới ${parsed.to} (loại ${parsed.kind}) không được gửi: ${result.reason} — môi trường chưa cấu hình Resend.`,
        );
      }
      // Gửi xong (hoặc transport khai báo bỏ qua): giữ nguyên dấu
      // đã chiếm làm dấu đã xử lý — không còn bước ghi dấu riêng.
      return { status: result.status };
    } catch (error) {
      // Gửi thất bại: nhả dấu TRƯỚC khi ném lỗi, để lượt thử lại
      // của BullMQ chiếm lại được dấu và gửi được. Lỗi của chính
      // thao tác nhả dấu không được nuốt lỗi gửi gốc.
      await this.sentMarker.release(data.outboxId).catch(() => undefined);
      throw error;
    }
  }
}
