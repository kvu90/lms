import { Injectable } from '@nestjs/common';
import type { GuardianDigestFrequency, GuardianDigestPreferenceView } from '@lms/contracts';
import { UsersService } from '../users/users.service';
import { GuardiansService } from './guardians.service';

/** Khoá user_preferences của tần suất digest theo từng con — worker đọc đúng khoá này khi quét. */
export function guardianDigestFrequencyPreferenceName(studentUserId: string): string {
  return `guardian_digest_frequency:${studentUserId}`;
}

/**
 * Bề mặt digest phụ huynh (PH-2, issue #159) còn ở phía API: chỉ còn
 * hai endpoint tuỳ chọn tần suất digest của phụ huynh (đọc/đặt qua
 * cổng liên kết giám hộ) — worker quét cửa sổ đọc đúng khoá tuỳ chọn
 * này khi chốt lượt.
 *
 * Nửa tổng hợp + gửi của digest KHÔNG còn ở phía API: từ issue con
 * #518 của #491, các sự kiện `guardian_digest_due` /
 * `guardian_overdue_alert` do lượt quét phía worker phát được relay
 * outbox duy nhất định tuyến sang hàng đợi `guardian-digest-events`
 * và xử lý tại `GuardianDigestHandlerService` phía worker (trước đó
 * là `GuardianDigestConsumer` polling + các hàm `process*` của chính
 * service này). Mọi luật nghiệp vụ của nửa gửi (chỉ dữ liệu đã công
 * bố, nội dung chỉ gồm số đếm + link sâu, kiểm lại cổng liên kết tại
 * thời điểm gửi, vết lượt `guardian_digests` là chốt idempotent)
 * giữ nguyên ở bản phía worker.
 */
@Injectable()
export class GuardianDigestService {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly users: UsersService,
  ) {}

  /** Tuỳ chọn digest hiện hành của phụ huynh cho một con (qua cổng liên kết; mặc định weekly). */
  async getPreference(guardianId: string, studentId: string): Promise<GuardianDigestPreferenceView> {
    await this.guardians.requireActiveLinkOr404(guardianId, studentId);
    const raw = await this.users.getPreference(guardianId, guardianDigestFrequencyPreferenceName(studentId));
    const frequency: GuardianDigestFrequency = raw === 'daily' || raw === 'off' ? raw : 'weekly';
    return { studentId, frequency };
  }

  /** Đặt tần suất digest cho một con — hiệu lực từ cửa sổ kế tiếp (worker chỉ chốt cửa sổ chưa có vết). */
  async setPreference(guardianId: string, studentId: string, frequency: GuardianDigestFrequency): Promise<GuardianDigestPreferenceView> {
    await this.guardians.requireActiveLinkOr404(guardianId, studentId);
    await this.users.setPreference(guardianId, guardianDigestFrequencyPreferenceName(studentId), frequency);
    return { studentId, frequency };
  }
}
