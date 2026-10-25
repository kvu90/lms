import { Inject, Injectable, Logger } from '@nestjs/common';

/**
 * Seam kênh ngoài Zalo OA cho digest phụ huynh (PH-2, issue #159):
 * research phụ huynh chốt Zalo CHỈ là kênh nhắc ngoài — không mang
 * điểm/dữ liệu cá nhân, chỉ nhắc + link sâu yêu cầu đăng nhập. Hạ tầng
 * Zalo OA (tài khoản OA, mẫu tin, token) chưa có nên lát này chỉ để
 * lại ĐÚNG seam này: interface port + bản cài đặt log-only. Khi có hạ
 * tầng, lát sau thay bản cài đặt bằng bản gửi thật (cùng hợp đồng, nội
 * dung đã tối thiểu hoá sẵn ở phía gọi) — không đổi luồng digest.
 */
export interface GuardianDigestZaloNotice {
  guardianUserId: string;
  studentUserId: string;
  /** weekly | daily | overdue_alert. */
  kind: string;
  /** Link sâu vào đúng màn của con sau đăng nhập (đường tương đối). */
  deepLink: string;
}

export interface GuardianDigestZaloPort {
  /**
   * Gửi một nhắc Zalo cho phụ huynh. Nội dung theo hợp đồng đã tối
   * thiểu hoá: chỉ loại lượt + link sâu — tuyệt đối không điểm số,
   * không dữ kiện chi tiết của con.
   */
  sendNotice(notice: GuardianDigestZaloNotice): Promise<void>;
}

/** Khoá tiêm port Zalo của digest phụ huynh. */
export const GUARDIAN_DIGEST_ZALO_PORT = Symbol('GUARDIAN_DIGEST_ZALO_PORT');

/**
 * Bản cài đặt log-only của port Zalo: ghi log ứng dụng thay cho gửi
 * thật — cùng triết lý port kênh ngoài của hệ thông báo (email/push
 * trước SMTP cũng chỉ được ghi log ở worker dispatch). KHÔNG ghi
 * dispatch log (tránh giả mạo "đã gửi Zalo"), KHÔNG hiện công tắc cài
 * đặt nào cho phụ huynh ở lát này.
 */
@Injectable()
export class LogOnlyGuardianDigestZaloPort implements GuardianDigestZaloPort {
  private readonly logger = new Logger(LogOnlyGuardianDigestZaloPort.name);

  async sendNotice(notice: GuardianDigestZaloNotice): Promise<void> {
    this.logger.log(
      `Zalo OA (log-only, chưa có hạ tầng): nhắc digest ${notice.kind} cho phụ huynh ${notice.guardianUserId}, con ${notice.studentUserId}, link sâu ${notice.deepLink}`,
    );
  }
}

/** Kiểu tiêm port Zalo vào service digest (để lát sau thay bản gửi thật không đổi chữ ký). */
export const InjectGuardianDigestZaloPort = () => Inject(GUARDIAN_DIGEST_ZALO_PORT);
