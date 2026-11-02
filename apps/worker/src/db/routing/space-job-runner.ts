import { Injectable } from '@nestjs/common';
import { tenantAls } from '../tenant-als';
import { SpaceRoutingError } from './space-connection-resolver';
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
 *    (bước chuẩn bị của khung chạy trong đó), sau khi đã chuẩn
 *    bị thêm handle Kysely của kho đó qua
 *    `getKyselyForSpace` — hai bảng chuẩn bị tách riêng: chỉ
 *    chuẩn bị Drizzle thì consumer đã chuyển sang Kysely sẽ bị
 *    `currentKysely` ném `prepared_revoked` fail-closed (slug đã
 *    ghi vào `dedicatedSlugs` mà chưa có mục Kysely). Mọi truy
 *    vấn qua handle định tuyến trong phiên đều vào kho của trung
 *    tâm, và ngữ cảnh mang cả `tenantId` của job để GUC RLS của
 *    kho đích theo đúng tenant của sự kiện.
 * 4. Phân giải lỗi (trung tâm bị gỡ khỏi sổ giữa lúc phát và lúc
 *    xử lý, bí mật/role lệch sổ, hoặc không đọc được control
 *    plane) → NÉM lỗi ra để BullMQ thử lại job, tuyệt đối không
 *    rơi về ngữ cảnh platform: cơ quan cô lập (sổ đăng ký) không
 *    đọc được thì job của trung tâm kho riêng không được phép
 *    hoàn tất "thành công" trên kho chung. Lỗi của bước chuẩn bị
 *    bên trong `withSpaceDatabase` (trung tâm đã ở kho riêng mà
 *    phiên không mở được) cũng ném ra như trước để BullMQ thử lại.
 *    Ngoại lệ duy nhất của bước 4: worker CHƯA CẤU HÌNH control
 *    plane (`space_routing.not_configured`) thì job chạy trên
 *    platform như trước đợt định tuyến — khi đó không có sổ đăng
 *    ký nào khẳng định trung tâm ở kho riêng, và khung giữ hợp
 *    đồng khởi động như trước (xem `SpaceDatabaseService`: biến
 *    chưa cấu hình thì worker vẫn chạy như cũ). Ngoại lệ này
 *    KHÔNG áp cho sổ đã cấu hình nhưng đọc lỗi (mất kết nối,
 *    bí mật/role lệch): các lỗi đó vẫn ném ra theo bước 4.
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
   * @throws Lỗi của `fn`; lỗi phân giải đích khi job mang slug
   *   khác null và định tuyến ĐÃ cấu hình (slug không còn trong
   *   sổ, bí mật thiếu/sai, role lệch sổ, không đọc được control
   *   plane) — truyền ra nguyên trạng để BullMQ thử lại job,
   *   tuyệt đối không chạy thân xử lý trên kho chung; hoặc lỗi
   *   của bước chuẩn bị khi trung tâm ở kho riêng mà kho không
   *   mở được. Riêng `space_routing.not_configured` (worker chưa
   *   cấu hình control plane) thì KHÔNG ném: job chạy trên
   *   platform như trước đợt định tuyến (xem bước 4 ở mô tả lớp).
   */
  async runForJob<T>(
    data: { spaceSlug?: string | null; tenantId?: string | null },
    fn: () => Promise<T>,
  ): Promise<T> {
    const slug = data.spaceSlug ?? null;
    if (slug) {
      let target: Awaited<ReturnType<SpaceDatabaseService['resolveTarget']>>;
      try {
        target = await this.spaceDb.resolveTarget(slug);
      } catch (err) {
        // Chưa cấu hình control plane (xem bước 4 ở mô tả lớp):
        // không có sổ đăng ký nào để đối chiếu nên worker chạy
        // như trước đợt định tuyến. Mọi lỗi phân giải khác đều
        // ném ra để BullMQ thử lại job, KHÔNG nuốt thành platform.
        if (
          err instanceof SpaceRoutingError &&
          err.code === 'space_routing.not_configured'
        ) {
          return tenantAls.run({ platform: true }, async () => fn());
        }
        throw err;
      }
      if (target?.mode === 'dedicated') {
        // Chuẩn bị cả handle Kysely của kho riêng trước khi mở
        // phiên: các consumer đã chuyển sang Kysely (cụm thông
        // báo) truy vấn qua `routedKysely`, mà bảng chuẩn bị phía
        // Kysely tách riêng với phía Drizzle — thiếu bước này thì
        // `currentKysely` ném `prepared_revoked` fail-closed vì
        // slug đã ghi vào `dedicatedSlugs` mà chưa có mục Kysely.
        // Lỗi chuẩn bị (bí mật thiếu/sai, sổ lệch) ném ra như
        // đường Drizzle để BullMQ thử lại, không rơi về platform.
        await this.spaceDb.getKyselyForSpace(slug);
        return this.spaceDb.withSpaceDatabase(slug, async () => fn(), {
          tenantId: data.tenantId ?? undefined,
        });
      }
    }
    return tenantAls.run({ platform: true }, async () => fn());
  }
}
