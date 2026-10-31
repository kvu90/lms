import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import Redis from 'ioredis';
import { renderAuthMail, type AuthMailPayload } from '@lms/contracts';
import { redisConnectionFromUrl } from '../config/env';
import { SpaceJobRunner } from '../db/routing/space-job-runner';
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
 * trình worker chồng lấn khi triển khai). Hàng rào vì vậy gồm HAI
 * TRẠNG THÁI tách bạch ở {@link AuthMailSentMarker}, không gộp vào
 * một khoá như bản đầu của đợt chuyển đổi (bản đó chiếm một khoá
 * duy nhất trước khi gửi và giữ luôn khoá làm dấu đã xử lý — tiến
 * trình sập sau khi chiếm mà trước khi gửi xong thì khoá vẫn đứng
 * tới hết hạn 7 ngày, mọi lần phát lại trong cửa sổ đó bị coi là
 * đã xử lý và mail mất hẳn dù job vẫn ghi thành công):
 *
 * - Dấu ĐÃ GỬI: chỉ ghi SAU KHI transport đã nhận mail (hoặc khai
 *   báo bỏ qua vì chưa cấu hình — coi như đã xử lý như đường cũ).
 *   Lượt xử lý thấy dấu này thì kết thúc `duplicate`: không gửi,
 *   không lỗi.
 * - Lease ĐANG XỬ LÝ: khoá riêng có token chủ sở hữu và hạn ngắn
 *   (60 giây), chiếm nguyên tử TRƯỚC khi gửi — đúng một lượt chiếm
 *   được lease và đi tiếp tới transport. Lượt không chiếm được
 *   lease KHÔNG được kết thúc như đã xử lý: nó hẹn hàng đợi phát
 *   lại sau bằng cơ chế hoãn của BullMQ (`moveToDelayed` +
 *   `DelayedError` — pattern hoãn chính thức của BullMQ, không
 *   tính là lần thử thất bại và không đốt số lần thử của job), vì
 *   tại thời điểm đó chưa biết lượt đang giữ lease có gửi thành
 *   công hay không. Khi job được phát lại, hoặc dấu ĐÃ GỬI đã
 *   đứng (lượt kia gửi xong — kết thúc `duplicate`), hoặc lease
 *   đã hết hạn/được nhả (chiếm lại và gửi).
 * - Đọc lại dấu ĐÃ GỬI TRONG lease: lượt chiếm được lease đọc
 *   lại dấu ĐÃ GỬI trong lúc đang giữ lease, TRƯỚC khi gọi
 *   transport — kết quả đọc lại này mới là kết quả có hiệu lực.
 *   Lần đọc trước khi chiếm lease chỉ là đường nhanh cho các lần
 *   phát lại thông thường, vì kết quả của nó có thể thành cũ:
 *   một lượt đọc "chưa gửi" rồi bị chậm trước khi chiếm lease,
 *   trong lúc lượt khác gửi trọn, ghi dấu và nhả lease; lượt đầu
 *   chiếm lại lease vừa nhả mà dựa vào kết quả cũ thì gửi lần
 *   hai dù không hề có lỗi nào xảy ra. Thấy dấu ở lần đọc lại
 *   thì lượt giữ lease nhả lease của chính mình (kiểm tra chủ)
 *   và kết thúc `duplicate`.
 * - Tiến trình sập SAU khi chiếm lease mà TRƯỚC khi gửi xong:
 *   lease tự hết hạn sau tối đa 60 giây; job của worker đã chết
 *   được BullMQ phát hiện qua khoá job hết hạn (mặc định 30 giây)
 *   và phát lại — lượt phát lại chiếm lại lease và GỬI ĐƯỢC mail,
 *   mail không mất. Nhả lease luôn kiểm tra token chủ sở hữu để
 *   một lượt không xoá nhầm lease mà lượt khác vừa chiếm lại sau
 *   khi lease cũ hết hạn.
 * - Giới hạn còn lại, đúng ngữ nghĩa at-least-once (không tuyên
 *   bố đúng-một-lần tuyệt đối với dịch vụ mail bên ngoài): tiến
 *   trình sập SAU khi transport đã nhận mail mà TRƯỚC khi ghi
 *   xong dấu ĐÃ GỬI — hoặc một lần gửi treo lâu hơn hạn lease —
 *   thì lượt khôi phục có thể gửi thêm một bản trùng của cùng
 *   mail đó. Mất mail im lặng thì không còn đường nào: mọi trạng
 *   thái chưa-gửi-được đều hoặc được thử lại, hoặc tự hết hạn để
 *   lượt sau gửi được.
 *
 * Hành vi theo từng kết quả xử lý một job:
 * - Payload không hợp lệ (thiếu/khác hai loại `kind` đã chốt, thiếu
 *   người nhận): ghi log lỗi và KẾT THÚC job không gửi, không ném
 *   lỗi — payload hỏng vĩnh viễn thì thử lại bao nhiêu lần cũng
 *   hỏng, không được để job độc chặn hàng đợi (đường cũ bỏ qua dòng
 *   theo đúng cách này).
 * - Transport trả `skipped` (chưa cấu hình `RESEND_API_KEY` /
 *   `MAIL_FROM`): môi trường chưa được cấp khoá là trạng thái vận
 *   hành hợp lệ — ghi log cảnh báo, ghi dấu ĐÃ GỬI và kết thúc job
 *   như đường cũ coi dòng là đã xử lý.
 * - Transport ném lỗi (mạng/4xx/5xx của Resend): NHẢ lease (kiểm
 *   tra chủ) rồi ném lỗi ra để cơ chế thử lại của BullMQ (chính
 *   sách job mặc định của `worker.module.ts`: tối đa 3 lần, giãn
 *   cách hàm mũ) phát lại job; lần thử sau chiếm lại lease nên vẫn
 *   gửi được và chỉ gửi đúng một lần khi thành công. Khác đường cũ
 *   ở cơ chế thử lại (hàng đợi thay cho bộ đếm trong tiến trình)
 *   và ở chỗ một job hỏng không còn chặn các mail đứng sau nó
 *   trong outbox.
 *
 * Side-effect: gửi mail qua Resend (qua transport phía worker);
 * đọc/ghi dấu ĐÃ GỬI và chiếm/nhả lease ĐANG XỬ LÝ theo `outboxId`
 * trên Redis qua {@link AuthMailSentMarker}. Không đọc/ghi DB,
 * không đụng `publishedAt`.
 */

/**
 * Hàng rào chống trùng hai trạng thái của sự kiện outbox theo
 * `outboxId` — bề mặt tối thiểu mà {@link AuthMailProcessor} cần
 * để đạt tính idempotent kể cả khi hai lượt xử lý chạy đồng thời
 * và khi một lượt chết giữa chừng. Bản cài đặt production là
 * {@link RedisAuthMailSentMarker} (mọi thao tác đều là lệnh Redis
 * nguyên tử); test cấp bản giả trong bộ nhớ có cùng ngữ nghĩa.
 */
export interface AuthMailSentMarker {
  /**
   * Sự kiện có `outboxId` này đã có dấu ĐÃ GỬI hay chưa. Dấu chỉ
   * được ghi sau khi transport đã nhận mail, nên `true` ở đây là
   * bằng chứng mail đã thật sự được gửi ở một lần xử lý trước.
   */
  hasSent(outboxId: string): Promise<boolean>;
  /**
   * Chiếm lease ĐANG XỬ LÝ theo `outboxId` một cách NGUYÊN TỬ:
   * trả token chủ sở hữu (chuỗi duy nhất của lượt chiếm) cho đúng
   * một lượt gọi khi chưa có lease còn hạn, trả `null` cho mọi
   * lượt gọi khác trong khi lease còn đứng. Lease có hạn ngắn —
   * tiến trình giữ lease chết trước khi gửi xong thì lease tự hết
   * hạn để lượt xử lý sau chiếm lại được và gửi được mail.
   */
  claimProcessing(outboxId: string): Promise<string | null>;
  /**
   * Ghi dấu ĐÃ GỬI theo `outboxId`: CHỈ gọi sau khi transport đã
   * nhận mail (hoặc khai báo bỏ qua vì chưa cấu hình). Đây là dấu
   * duy nhất khiến các lần phát lại sau đó kết thúc `duplicate`.
   */
  markSent(outboxId: string): Promise<void>;
  /**
   * Nhả lease ĐANG XỬ LÝ theo `outboxId` CÓ KIỂM TRA CHỦ: chỉ xoá
   * khoá khi `ownerToken` khớp token đã ghi lúc chiếm — một lượt
   * kết thúc muộn không xoá nhầm lease mà lượt khác vừa chiếm lại
   * sau khi lease của nó hết hạn.
   */
  releaseProcessing(outboxId: string, ownerToken: string): Promise<void>;
}

/** Khoá tiêm của {@link AuthMailSentMarker} trong `worker.module.ts`. */
export const AUTH_MAIL_SENT_MARKER = 'AUTH_MAIL_SENT_MARKER';

/** Tiền tố khoá Redis của dấu ĐÃ GỬI: `lms:auth-mail:sent:<outboxId>`. */
const SENT_MARKER_KEY_PREFIX = 'lms:auth-mail:sent:';

/** Tiền tố khoá Redis của lease ĐANG XỬ LÝ: `lms:auth-mail:processing:<outboxId>`. */
const PROCESSING_LEASE_KEY_PREFIX = 'lms:auth-mail:processing:';

/**
 * Thời gian sống của dấu ĐÃ GỬI: 7 ngày. Mọi cửa sổ phát lại thực
 * tế (thử lại của BullMQ, phát lại của relay sau sự cố) đều tính
 * bằng phút tới giờ, còn bí mật trong mail chỉ sống tối đa 1 giờ
 * (liên kết reset) và 5 phút (mã OTP) — dấu sống lâu hơn hẳn mọi
 * cửa sổ đó nhưng vẫn tự dọn để Redis không tích lũy vô hạn theo
 * số sự kiện.
 */
const SENT_MARKER_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Thời gian sống của lease ĐANG XỬ LÝ: 60 giây. Một lần gửi qua
 * Resend bình thường hoàn tất trong vài giây, nên 60 giây cho biên
 * rộng nhiều lần so với một lần gửi mà vẫn đủ ngắn để khôi phục
 * sau sập kịp tuổi thọ ngắn nhất của bí mật trong mail (mã OTP 5
 * phút): BullMQ phát hiện job của worker đã chết qua khoá job hết
 * hạn (mặc định 30 giây) rồi phát lại, và cơ chế hoãn thử lại 5
 * giây bắc qua phần hạn lease còn lại nếu lượt phát lại tới sớm
 * hơn lúc lease hết hạn.
 */
const PROCESSING_LEASE_TTL_SECONDS = 60;

/**
 * Khoảng hoãn khi hẹn hàng đợi phát lại một job gặp lease đang bị
 * lượt khác giữ: 5 giây — đủ ngắn để mail không trễ đáng kể khi
 * lượt giữ lease gửi xong ngay sau đó, đủ dài để không quay vòng
 * vô ích trong lúc chờ lease hết hạn (tối đa 60 giây).
 */
const PROCESSING_RETRY_DELAY_MS = 5000;

/**
 * Script Lua nhả lease có kiểm tra chủ: chỉ `DEL` khi giá trị đang
 * lưu đúng token của lượt nhả. Kiểm-tra-và-xoá phải là MỘT thao
 * tác nguyên tử phía Redis — làm bằng `GET` rồi `DEL` ở hai lệnh
 * rời nhau thì lease của lượt mới (chiếm lại sau khi lease cũ hết
 * hạn) có thể bị xoá nhầm trong khe giữa hai lệnh.
 */
const RELEASE_PROCESSING_IF_OWNER_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Bản cài đặt Redis của {@link AuthMailSentMarker}: mỗi sự kiện có
 * hai khoá độc lập — `lms:auth-mail:sent:<outboxId>` (dấu ĐÃ GỬI,
 * hạn {@link SENT_MARKER_TTL_SECONDS}) và
 * `lms:auth-mail:processing:<outboxId>` (lease ĐANG XỬ LÝ mang
 * token chủ sở hữu, hạn {@link PROCESSING_LEASE_TTL_SECONDS}).
 * Chiếm lease bằng `SET ... NX` (lệnh nguyên tử phía Redis — đúng
 * một lượt trong mọi lượt đồng thời nhận được khoá); nhả lease
 * bằng script Lua kiểm tra chủ. Kết nối Redis tạo lười theo đúng
 * khuôn của `NotificationDeliveryService` (chỉ mở kết nối khi job
 * đầu tiên cần thao tác dấu) và đóng khi module huỷ.
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

  /** Kết nối Redis tạo lười cho các khoá dấu của mail auth. */
  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis({
        ...redisConnectionFromUrl(this.config.getOrThrow<string>('REDIS_URL')),
      });
      this.client.on('error', (error: Error) => {
        this.logger.warn(`Redis của dấu mail auth lỗi: ${error.message}`);
      });
    }
    return this.client;
  }

  async hasSent(outboxId: string): Promise<boolean> {
    return (await this.redis().get(`${SENT_MARKER_KEY_PREFIX}${outboxId}`)) !== null;
  }

  async claimProcessing(outboxId: string): Promise<string | null> {
    const ownerToken = randomUUID();
    const result = await this.redis().set(
      `${PROCESSING_LEASE_KEY_PREFIX}${outboxId}`,
      ownerToken,
      'EX',
      PROCESSING_LEASE_TTL_SECONDS,
      'NX',
    );
    return result === 'OK' ? ownerToken : null;
  }

  async markSent(outboxId: string): Promise<void> {
    await this.redis().set(`${SENT_MARKER_KEY_PREFIX}${outboxId}`, '1', 'EX', SENT_MARKER_TTL_SECONDS);
  }

  async releaseProcessing(outboxId: string, ownerToken: string): Promise<void> {
    await this.redis().eval(
      RELEASE_PROCESSING_IF_OWNER_SCRIPT,
      1,
      `${PROCESSING_LEASE_KEY_PREFIX}${outboxId}`,
      ownerToken,
    );
  }
}

/** Kết quả xử lý một job của {@link AuthMailProcessor} (để quan sát và kiểm chứng ở test). */
export interface AuthMailProcessResult {
  status:
    /** Mail đã được transport nhận gửi ở lần xử lý này. */
    | 'sent'
    /** Transport bỏ qua vì chưa cấu hình Resend — coi như đã xử lý như đường cũ. */
    | 'skipped'
    /** Sự kiện đã có dấu ĐÃ GỬI theo `outboxId` (transport đã nhận mail ở lần xử lý trước) — lần này bị bỏ qua. */
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
    private readonly jobRunner: SpaceJobRunner,
  ) {
    super();
  }

  /**
   * Xử lý MỘT job mail auth.
   *
   * @param job Job do relay phát: `job.data` là toàn bộ dòng outbox
   * đã chuẩn hoá; định danh chống trùng là `job.data.outboxId`.
   * @param token Token khoá job do worker của BullMQ cấp (NestJS
   * truyền qua `WorkerHost.process`) — cần cho thao tác hoãn job
   * `moveToDelayed`; các lượt gọi trực tiếp không qua worker (test)
   * bỏ qua tham số này.
   * @returns Kết quả xử lý theo {@link AuthMailProcessResult}.
   * @throws `DelayedError` của BullMQ khi một lượt xử lý khác đang
   * giữ lease của sự kiện: đây là TÍN HIỆU HẸN THỬ LẠI, không phải
   * lỗi nghiệp vụ — job được hoãn {@link PROCESSING_RETRY_DELAY_MS}
   * bằng `moveToDelayed` (khi có token của worker) trước khi lỗi
   * được ném, nên lần hoãn không tính là lần thử thất bại và không
   * đốt số lần thử của job; job TUYỆT ĐỐI không kết thúc như đã xử
   * lý trong tình huống này, vì chưa biết lượt giữ lease có gửi
   * thành công hay không.
   * @throws Lỗi của transport Resend — ném ra để BullMQ thử lại
   * job theo chính sách mặc định, nhưng CHỈ sau khi đã nhả lease
   * (kiểm tra chủ), nên lần thử lại chiếm lại được lease và gửi
   * được (không bị lease của lần lỗi chặn).
   * @throws Lỗi Redis khi kiểm tra dấu ĐÃ GỬI (lần đọc nhanh
   * trước khi chiếm lease, hoặc lần đọc lại trong lúc giữ
   * lease) hoặc chiếm lease — ném ra TRƯỚC khi bất kỳ mail nào
   * được gửi ở lần xử lý đó; riêng lần đọc lại lỗi thì lease
   * được nhả (kiểm tra chủ) trước khi ném.
   * @throws Lỗi Redis khi ghi dấu ĐÃ GỬI sau khi transport đã nhận
   * mail — lease được nhả trước khi ném, lần thử lại gửi lại từ
   * đầu; đây là đường duy nhất có thể sinh mail trùng (transport
   * đã nhận nhưng dấu chưa đứng), đúng giới hạn at-least-once đã
   * ghi ở đầu file.
   */
  async process(job: Job<OutboxEventJobData>, token?: string): Promise<AuthMailProcessResult> {
    // Job chạy trong phiên đúng với trung tâm mà sự kiện thuộc về
    // qua `SpaceJobRunner` (issue #582) — cùng một đường như mọi
    // consumer của relay: trung tâm ở kho riêng thì phiên theo
    // trung tâm được mở trước khi thân xử lý chạy; trung tâm ở
    // kho chung thì là ngữ cảnh platform như hiện tại. Thân xử
    // lý ở `processInContext` không đổi.
    return this.jobRunner.runForJob(job.data, () => this.processInContext(job, token));
  }

  /** Thân xử lý một job mail auth trong phiên đã mở — xem `process`. */
  private async processInContext(job: Job<OutboxEventJobData>, token?: string): Promise<AuthMailProcessResult> {
    const data = job.data;
    const parsed = (data?.payload ?? null) as AuthMailPayload | null;
    if (!parsed || (parsed.kind !== 'password_reset' && parsed.kind !== 'email_otp') || !parsed.to) {
      this.logger.error(
        `Payload mail auth không hợp lệ, bỏ qua job của dòng outbox ${data?.outboxId}: ${JSON.stringify(parsed)?.slice(0, 200)}`,
      );
      return { status: 'invalid' };
    }

    // Hàng rào idempotent, trạng thái ĐÃ GỬI — lần đọc nhanh
    // trước khi chiếm lease: dấu chỉ tồn tại khi transport đã
    // thật sự nhận mail ở một lần xử lý trước — thấy dấu này thì
    // bỏ qua ngay, không gửi lại. Kết quả lần đọc này CHƯA phải
    // kết quả có hiệu lực: một lượt có thể đọc "chưa gửi" rồi bị
    // chậm trước khi chiếm lease, trong lúc lượt khác gửi trọn,
    // ghi dấu và nhả lease — kết quả có hiệu lực là lần đọc lại
    // trong lúc đang giữ lease ở dưới.
    if (await this.sentMarker.hasSent(data.outboxId)) {
      this.logger.log(
        `Mail auth của dòng outbox ${data.outboxId} đã được gửi ở lần xử lý trước — bỏ qua lần phát lại.`,
      );
      return { status: 'duplicate' };
    }

    // Hàng rào idempotent, trạng thái ĐANG XỬ LÝ: chiếm lease
    // nguyên tử theo outboxId trước khi gửi. Không chiếm được
    // nghĩa là một lượt khác đang xử lý sự kiện này (hoặc lease
    // của một lượt đã chết chưa hết hạn) — chưa biết mail có được
    // gửi hay không, nên không kết thúc như đã xử lý mà hẹn hàng
    // đợi phát lại sau theo pattern hoãn của BullMQ.
    const leaseToken = await this.sentMarker.claimProcessing(data.outboxId);
    if (!leaseToken) {
      this.logger.log(
        `Mail auth của dòng outbox ${data.outboxId} đang được một lượt xử lý khác giữ lease — hẹn hàng đợi phát lại sau ${PROCESSING_RETRY_DELAY_MS}ms.`,
      );
      if (token) {
        await job.moveToDelayed(Date.now() + PROCESSING_RETRY_DELAY_MS, token);
      }
      throw new DelayedError();
    }

    try {
      // Đọc lại dấu ĐÃ GỬI trong lúc đang giữ lease, TRƯỚC khi
      // gọi transport: đây là kết quả có hiệu lực. Nếu một lượt
      // khác đã gửi trọn và ghi dấu trong cửa sổ lượt này bị
      // chậm trước khi chiếm lease (lần đọc nhanh ở trên cho
      // kết quả cũ "chưa gửi"), dấu giờ đã đứng — nhả lease của
      // chính lượt này (kiểm tra chủ) và kết thúc `duplicate`,
      // không gửi lần hai. Lỗi của thao tác nhả ở đây bị nuốt
      // có chủ đích như ở bước thành công: dấu ĐÃ GỬI đã đứng
      // và tự nó bảo đảm các lần phát lại bỏ qua; lease còn sót
      // sẽ tự hết hạn trong hạn ngắn.
      if (await this.sentMarker.hasSent(data.outboxId)) {
        this.logger.log(
          `Mail auth của dòng outbox ${data.outboxId} đã được gửi bởi lượt xử lý vừa nhả lease — bỏ qua, không gửi lần hai.`,
        );
        await this.sentMarker.releaseProcessing(data.outboxId, leaseToken).catch(() => undefined);
        return { status: 'duplicate' };
      }

      const message = renderAuthMail(parsed);
      const result = await this.mailer.send(message);
      if (result.status === 'skipped') {
        this.logger.warn(
          `Mail auth tới ${parsed.to} (loại ${parsed.kind}) không được gửi: ${result.reason} — môi trường chưa cấu hình Resend.`,
        );
      }
      // Transport đã nhận mail (hoặc khai báo bỏ qua — coi như đã
      // xử lý như đường cũ): CHỈ BÂY GIỜ mới ghi dấu ĐÃ GỬI, rồi
      // nhả lease ngay trong cùng bước thành công. Lỗi của thao
      // tác nhả ở đây bị nuốt có chủ đích (dấu ĐÃ GỬI đã đứng và
      // tự nó bảo đảm các lần phát lại bỏ qua; lease còn sót sẽ
      // tự hết hạn trong hạn ngắn) — không để lỗi nhả biến một lần
      // gửi thành công thành job thất bại.
      await this.sentMarker.markSent(data.outboxId);
      await this.sentMarker.releaseProcessing(data.outboxId, leaseToken).catch(() => undefined);
      return { status: result.status };
    } catch (error) {
      // Gửi thất bại, đọc lại dấu ĐÃ GỬI trong lease thất bại,
      // hoặc ghi dấu ĐÃ GỬI thất bại: nhả lease (kiểm tra chủ)
      // TRƯỚC khi ném lỗi, để lượt thử lại của BullMQ chiếm lại
      // được lease và gửi được. Lỗi của chính thao tác nhả
      // lease không được nuốt lỗi gốc.
      await this.sentMarker.releaseProcessing(data.outboxId, leaseToken).catch(() => undefined);
      throw error;
    }
  }
}
