import { Injectable } from '@nestjs/common';
import { tenantAls } from '../tenant-als';
import { SpaceDatabaseService } from './space-database.service';

/**
 * Bộ chạy job theo trung tâm (issue #582) — điểm vào duy nhất để
 * các processor tiêu thụ job outbox mở đúng kho của trung tâm mà
 * job thuộc về.
 *
 * Dữ liệu job do relay phát mang `spaceSlug` — slug của trung tâm
 * mà tenant của sự kiện thuộc về (relay suy ra từ tenant của dòng
 * outbox lúc phát; sự kiện của trung tâm ở kho riêng thì chính
 * relay đã đọc dòng từ kho của trung tâm đó). Luồng chạy một job:
 *
 * 1. Job không mang slug (sự kiện không gắn tenant, hoặc tenant
 *    không còn dòng tenant tương ứng) → chạy trong ngữ cảnh
 *    platform tường minh như hiện tại.
 * 2. Slug phân giải qua khung định tuyến ra trung tâm ở KHO
 *    CHUNG → cũng chạy trong ngữ cảnh platform như hiện tại: kho
 *    chung là một database dùng chung, phiên platform thấy đúng
 *    dữ kiện của trung tâm như trước đợt này.
 * 3. Slug phân giải ra trung tâm ở KHO RIÊNG → mở phiên theo
 *    trung tâm qua `SpaceDatabaseService.withSpaceDatabase`
 *    (bước chuẩn bị của khung chạy trong đó): mọi truy vấn qua
 *    handle định tuyến trong phiên đều vào kho của trung tâm, và
 *    ngữ cảnh mang cả `tenantId` của job để GUC RLS của kho đích
 *    theo đúng tenant của sự kiện.
 * 4. Phân giải lỗi (trung tâm bị gỡ khỏi sổ giữa lúc phát và lúc
 *    xử lý, hoặc tầng định tuyến chưa cấu hình) → rơi về ngữ cảnh
 *    platform như hiện tại thay vì làm chết job: job vẫn phải được
 *    xử lý, và với kho chung/platform thì đó là đúng đích; riêng
 *    ca trung tâm đã ở kho riêng mà phiên không mở được thì lỗi
 *    của bước chuẩn bị bên trong `withSpaceDatabase` vẫn ném ra
 *    bình thường để BullMQ thử lại job.
 *
 * Tính idempotent của processor theo `outboxId` không đổi: bộ
 * chạy này chỉ quyết ngữ cảnh/kho cho lượt xử lý, không chen vào
 * luật chống trùng của từng processor.
 */
@Injectable()
export class SpaceJobRunner {
  constructor(private readonly spaceDb: SpaceDatabaseService) {}

  /**
   * Chạy `fn` trong phiên làm việc đúng với trung tâm của job.
   *
   * @param data - Định danh trung tâm của job: `spaceSlug` relay
   *   gắn lúc phát (null khi sự kiện không thuộc trung tâm nào
   *   xác định được) và `tenantId` của sự kiện.
   * @param fn - Thân xử lý của processor cho job này.
   * @returns Kết quả của `fn`.
   * @throws Lỗi của `fn`, hoặc lỗi của bước chuẩn bị khi trung
   *   tâm ở kho riêng mà kho không mở được (bí mật/role lệch sổ)
   *   — truyền ra để BullMQ thử lại job theo chính sách hiện hành.
   */
  async runForJob<T>(
    data: { spaceSlug?: string | null; tenantId?: string | null },
    fn: () => Promise<T>,
  ): Promise<T> {
    const slug = data.spaceSlug ?? null;
    if (slug) {
      let dedicated = false;
      try {
        dedicated = (await this.spaceDb.resolveTarget(slug)).mode === 'dedicated';
      } catch {
        // Không phân giải được đích (xem bước 4 ở mô tả lớp): rơi
        // về đường platform như hiện tại thay vì làm chết job.
        dedicated = false;
      }
      if (dedicated) {
        return this.spaceDb.withSpaceDatabase(slug, async () => fn(), {
          tenantId: data.tenantId ?? undefined,
        });
      }
    }
    return tenantAls.run({ platform: true }, async () => fn());
  }
}
