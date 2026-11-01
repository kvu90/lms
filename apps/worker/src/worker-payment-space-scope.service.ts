import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenants } from '@lms/db';
import { SharedDomainError } from '@lms/enrol';
import { tenantAls } from './db/tenant-als';
import type { relations } from './db/relations';
import { SpaceDatabaseService } from './db/routing/space-database.service';
import { SpaceRoutingError } from './db/routing/space-connection-resolver';

type Database = NodePgDatabase<typeof relations>;

/**
 * Điểm phân giải không gian DUY NHẤT cho các cổng thanh toán phía
 * worker (tiền điều kiện Phần B của issue #587, hạng mục 2): từ
 * `tenantId` của payment → slug của tenant → chế độ kho trong sổ
 * đăng ký control plane, rồi chạy thân nghiệp vụ trong phạm vi kho
 * đó. Nhịp quét matching và nhịp quét lại (sự kiện `processing`
 * treo được nhận lại) đều đi qua đây qua đầu vào hai service kích
 * hoạt và cổng đối chiếu đích — mỗi payment phân giải độc lập nên
 * một nhịp quét chứa payment của nhiều trung tâm vẫn kích hoạt
 * đúng kho của từng payment.
 *
 * Flow:
 * 1. Tra slug từ dòng `tenants` ở KHO CHUNG trong phạm vi platform
 *    (chỉ lấy slug — dữ kiện thư mục; đợt di trú giữ ánh xạ này
 *    tra được sau khi lật định tuyến, như phương án A1 của hạng
 *    mục 3 trong cùng đặc tả). Không có dòng tenant → lỗi
 *    `tenant.not_found` tường minh.
 * 2. Phân giải đích qua `SpaceDatabaseService.resolveTarget`:
 *    - Kho chung → chạy thân trong ngữ cảnh platform như hành vi
 *      hiện tại (không đổi gì).
 *    - Kho riêng → chạy thân trong `withSpaceDatabase(slug)` dưới
 *      ngữ cảnh platform mang slug: handle định tuyến đã inject
 *      vào các service tự dẫn mọi lượt đọc/ghi (kể cả bề mặt vật
 *      chất hoá và outbox) vào kho riêng.
 * 3. Fail-closed:
 *    - Trung tâm chưa có dòng đăng ký (`space_not_found`) hoặc
 *      worker chưa cấu hình control plane (`not_configured`) →
 *      kho chung: một trung tâm chưa đăng ký thì không thể có kho
 *      riêng, nên đây không phải là rơi lặng mà là kết luận từ
 *      chính sổ đăng ký (nguồn sự thật duy nhất cho đích).
 *    - Mọi lỗi phân giải/chuẩn bị khác (bí mật thiếu, role lệch,
 *      kho đích không tới được) → ném nguyên lỗi: nhịp matching
 *      bắt từng sự kiện và ghi cảnh báo, payment ở lại `pending`
 *      để nhịp sau thử lại — tuyệt đối không ghi vào kho chung.
 *
 * @throws SharedDomainError mã `tenant.missing` khi nơi gọi không
 * truyền `tenantId`, `tenant.not_found` khi không có dòng tenant ở
 * kho chung; hoặc `SpaceRoutingError` của khung định tuyến khi kho
 * đích chuẩn bị lỗi.
 */
@Injectable()
export class WorkerPaymentSpaceScopeService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly spaces: SpaceDatabaseService,
  ) {}

  /**
   * Chạy `fn` trong phạm vi kho của tenant sở hữu payment.
   *
   * @param tenantId - Id tenant của payment (`payment.tenantId`);
   * vắng thì lỗi ngay thay vì đoán kho chung.
   * @param fn - Thân nghiệp vụ (đọc/ghi qua handle định tuyến đã
   * inject — handle tự dẫn vào kho đích theo ngữ cảnh ALS).
   */
  async runForPaymentTenant<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!tenantId) {
      throw new SharedDomainError('tenant.missing', 'Payment has no tenantId to resolve its space');
    }
    const slug = await this.resolveTenantSlug(tenantId);
    let mode: 'shared' | 'dedicated';
    try {
      mode = (await this.spaces.resolveTarget(slug)).mode;
    } catch (error) {
      // Chưa đăng ký kho riêng (hoặc chưa cấu hình control plane):
      // trung tâm đó chỉ có thể ở kho chung — giữ hành vi hiện tại.
      if (
        error instanceof SpaceRoutingError &&
        (error.code === 'space_routing.space_not_found' ||
          error.code === 'space_routing.not_configured')
      ) {
        return tenantAls.run({ platform: true }, fn);
      }
      throw error;
    }
    if (mode === 'shared') {
      return tenantAls.run({ platform: true }, fn);
    }
    // Kho riêng: bọc platform ngoài rồi mở phiên theo trung tâm —
    // `withSpaceDatabase` giữ nguyên `platform: true` của ngữ cảnh
    // cha (không truyền `tenantId` vào context, vì truyền tenant
    // sẽ lật cờ platform về false theo hợp đồng của nó) và gắn
    // thêm `spaceSlug`, đồng thời chuẩn bị handle kho đích trước
    // khi thân chạy — chuẩn bị lỗi thì ném tại đây, thân chưa ghi
    // gì vào đâu cả.
    return tenantAls.run({ platform: true }, () =>
      this.spaces.withSpaceDatabase(slug, () => fn()),
    );
  }

  /**
   * Tra slug của tenant từ kho chung.
   *
   * Bọc platform TƯƠI (không mang slug môi trường): `tenantAls.run`
   * thay toàn bộ store nên slug của một phiên theo trung tâm đang
   * chạy ngoài (nếu có) không kéo lượt tra này sang kho riêng —
   * lượt tra luôn vào kho chung, nơi giữ dòng thư mục tenant.
   */
  private async resolveTenantSlug(tenantId: string): Promise<string> {
    // Callback PHẢI là async (cùng lý do với `withSpaceDatabase`):
    // truy vấn Drizzle là thenable lười — điểm await quyết định
    // ngữ cảnh ALS phải nằm TRONG `run` thì `TenantAwarePool` mới
    // gắn GUC platform đúng lúc checkout kết nối; trả thenable
    // trần ra ngoài `run` thì lượt đọc chạy ngoài ngữ cảnh và RLS
    // fail-closed che dòng tenant thành "không thấy" giả.
    const [row] = await tenantAls.run({ platform: true }, async () =>
      this.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)),
    );
    if (!row) {
      throw new SharedDomainError('tenant.not_found', `Tenant ${tenantId} not found`);
    }
    return row.slug;
  }
}
