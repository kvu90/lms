import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenants } from '@lms/db';
import { SharedDomainError } from '@lms/enrol';
import { tenantAls } from './db/tenant-als';
import type { relations } from './db/relations';
import {
  SpaceRoutingError,
  type ResolvedSpaceConnection,
} from './db/routing/space-connection-resolver';
import { SpaceDatabaseService } from './db/routing/space-database.service';

type Database = NodePgDatabase<typeof relations>;

/**
 * Điểm phân giải không gian DUY NHẤT cho các hiệu ứng theo payment
 * ở worker (tiền điều kiện Phần B của issue #587 — hạng mục 2):
 * các cổng kích hoạt ghi danh trả phí và phép đối chiếu đích của
 * luồng matching phải chạy tại đúng kho của trung tâm sở hữu
 * payment, trong khi nhịp quét matching chạy xuyên trung tâm trên
 * kho chung và không mang slug của bất kỳ trung tâm nào.
 *
 * Flow của {@link WorkerPaymentSpaceScope.runForTenant}:
 *
 * 1. Ánh xạ `tenantId` của payment → `slug` của tenant bằng lượt
 *    đọc THƯ MỤC ở kho chung trong phạm vi platform (chỉ lấy cột
 *    `slug` — dữ kiện thư mục, không đọc dữ kiện nghiệp vụ của
 *    trung tâm). Đây là cùng nguồn ánh xạ mà đường đọc quản trị
 *    tenant theo đích dùng: đợt di trú có nghĩa vụ giữ ánh xạ thư
 *    mục này tra được ở kho chung sau khi lật định tuyến. Không
 *    thấy dòng thư mục → ném `tenant.not_found`: payment trỏ tới
 *    một trung tâm không xác định được kho là trạng thái dữ kiện
 *    hỏng, phải lỗi tường minh thay vì ghi bừa vào kho chung.
 * 2. Phân giải slug qua sổ đăng ký control plane
 *    (`SpaceDatabaseService.resolveTarget`):
 *    - Trung tâm ở kho chung → chạy thân xử lý trong ngữ cảnh
 *      platform như hành vi hiện tại, không đổi điểm nào.
 *    - Trung tâm ở kho riêng → chạy thân xử lý trong phiên theo
 *      trung tâm (`withSpaceDatabase`): khung chuẩn bị handle của
 *      kho đích và mở ngữ cảnh ALS mang slug, nên mọi truy vấn
 *      qua handle định tuyến của worker trong thân xử lý vào đúng
 *      kho của trung tâm.
 *    - Worker chưa cấu hình control plane
 *      (`space_routing.not_configured`) → chạy platform như trước
 *      đợt định tuyến, cùng ngoại lệ đã chốt của `SpaceJobRunner`:
 *      khi đó không có sổ đăng ký nào khẳng định trung tâm ở kho
 *      riêng. Mọi lỗi phân giải khác (slug không còn trong sổ,
 *      bí mật/role lệch, không đọc được control plane) và lỗi
 *      chuẩn bị kho đích đều NÉM ra — fail-closed: thân xử lý
 *      không bao giờ chạy trên kho chung cho một trung tâm có bản
 *      ghi kho riêng, và nhịp matching bắt lỗi theo từng sự kiện
 *      (payment ở lại `pending` kèm cảnh báo, nhịp sau thử lại).
 *
 * Bất biến: service này chỉ quyết kho và ngữ cảnh cho lượt xử lý;
 * nó không giữ luật nghiệp vụ nào của các hiệu ứng dùng nó, và
 * tính idempotent của từng hiệu ứng không đổi.
 *
 * Điều kiện chạy: `SpaceDatabaseService` phải đã được gắn handle
 * kho chung THÔ bởi module sở hữu tiến trình (factory của
 * `DrizzleModule` trong `worker.module.ts` gắn handle Drizzle
 * trên pool kho chung — KHÔNG phải handle định tuyến, vì gắn
 * handle định tuyến làm đích uỷ thác sẽ tự uỷ thác vào chính nó).
 * Lượt đọc thư mục slug ở bước 1 đi qua handle định tuyến được
 * inject ở phạm vi platform nên uỷ thác về đúng handle kho chung
 * đã gắn đó.
 */
@Injectable()
export class WorkerPaymentSpaceScope {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly spaceDatabase: SpaceDatabaseService,
  ) {}

  /**
   * Chạy `fn` trong phạm vi kho của trung tâm sở hữu một payment.
   *
   * @param tenantId - Id của tenant sở hữu payment (trường
   *   `tenantId` của bản ghi payment).
   * @param fn - Thân xử lý của hiệu ứng (kích hoạt ghi danh, kích
   *   hoạt ghi danh cấp lớp, hoặc đối chiếu đích).
   * @returns Kết quả của `fn`.
   * @throws SharedDomainError mã `tenant.not_found` khi không có
   *   dòng thư mục của tenant ở kho chung; lỗi phân giải đích hoặc
   *   lỗi chuẩn bị kho đích (fail-closed, xem bước 2); hoặc lỗi
   *   của chính `fn`.
   */
  async runForTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const slug = await this.slugForTenant(tenantId);
    let target: ResolvedSpaceConnection;
    try {
      target = await this.spaceDatabase.resolveTarget(slug);
    } catch (err) {
      // Chưa cấu hình control plane (xem bước 2 ở mô tả lớp):
      // không có sổ đăng ký nào để đối chiếu nên chạy như trước
      // đợt định tuyến. Mọi lỗi phân giải khác ném ra nguyên
      // trạng, tuyệt đối không rơi về kho chung.
      if (err instanceof SpaceRoutingError && err.code === 'space_routing.not_configured') {
        return tenantAls.run({ platform: true }, async () => fn());
      }
      throw err;
    }
    if (target.mode === 'dedicated') {
      return this.spaceDatabase.withSpaceDatabase(slug, async () => fn());
    }
    return tenantAls.run({ platform: true }, async () => fn());
  }

  /**
   * Ánh xạ `tenantId` → `slug` qua lượt đọc thư mục ở kho chung.
   *
   * Lượt đọc chạy trong phạm vi platform tường minh và điểm
   * `await` nằm trong `tenantAls.run` (bọc hàm async) để GUC
   * platform được gắn đúng khi kết nối checkout — cùng lý do với
   * bọc async trong `SpaceDatabaseService.withSpaceDatabase`:
   * truy vấn Drizzle là thenable lười, trả thenable ra ngoài
   * `run` thì ngữ cảnh bị mất trước khi truy vấn thật sự chạy.
   *
   * @param tenantId - Id của tenant cần tra slug.
   * @returns Slug của tenant trong sổ đăng ký.
   * @throws SharedDomainError mã `tenant.not_found` khi kho chung
   *   không có dòng thư mục của tenant.
   */
  private async slugForTenant(tenantId: string): Promise<string> {
    const [row] = await tenantAls.run({ platform: true }, async () =>
      this.db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)),
    );
    if (!row) {
      throw new SharedDomainError(
        'tenant.not_found',
        `Tenant ${tenantId} not found in the shared directory`,
      );
    }
    return row.slug;
  }
}
