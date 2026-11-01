/**
 * Repository CẤU HÌNH SITE trên Kysely — chuyển đổi Drizzle →
 * Kysely của chiến dịch chuyển tầng dữ liệu (issue #641, nhóm G1).
 *
 * Vai trò: mọi truy cập tới ba bảng của tầng hạ tầng — `config`
 * cho setting của core (giá trị jsonb), `plugin_config` cho
 * setting theo component/plugin (giá trị text chứa JSON) và
 * `admin_setting_audit` ghi vết mọi thay đổi do quản trị thực
 * hiện — tập trung ở đây. Repository không chứa luật nghiệp vụ —
 * hợp đồng setting, giá trị mặc định trong code và cổng quyền nằm
 * ở tầng service phía ứng dụng.
 *
 * Điểm nóng của nhóm: upsert setting plugin ở tầng platform. Dòng
 * platform của `plugin_config` mang `tenant_id` NULL và tính duy
 * nhất của nó được bảo đảm bằng CHỈ SỐ DUY NHẤT RIÊNG PHẦN
 * `plugin_config_platform_plugin_name_unique` trên `(plugin, name)
 * WHERE tenant_id is null` — vì vậy mệnh đề xung đột của upsert
 * PHẢI mang vị từ của chỉ số đó để PostgreSQL suy ra đúng chỉ số
 * đích (đường Drizzle trước đây khai bằng `targetWhere`). Phía
 * Kysely, vị từ này là `.where(...)` gọi trên builder xung đột
 * TRƯỚC `doUpdateSet` (nó biên dịch thành `indexWhere` của nút
 * ON CONFLICT, đặt ngay sau đích xung đột) — khác hẳn `.where`
 * gọi SAU `doUpdateSet`, vốn là điều kiện của chính nhánh cập
 * nhật. Tương đương này được kiểm chứng ở mã nguồn kysely 0.29.7
 * (`OnConflictBuilder` thực thi `WhereInterface`, nút xung đột
 * mang hai trường `indexWhere`/`updateWhere` riêng) và được chốt
 * bằng spec tương đương ở `user-centre-cluster.int-spec.ts`: cập nhật
 * đúng khi điều kiện đích khớp, không cập nhật dòng tenant khi
 * ghi đè ở tầng platform.
 *
 * Khuôn hình dạng dữ liệu — cùng khuôn pilot kho control plane
 * (xem `control-plane.ts` và playbook trong `AGENTS.md` của
 * package): truy vấn viết trên interface schema sinh bằng codegen
 * (tên bảng/cột snake_case), cột được chọn bằng danh sách tường
 * minh có bí danh camelCase, giá trị jsonb ghi qua helper
 * serialize + ép kiểu `::jsonb` (mẫu `jsonbValue` của pilot; giá
 * trị `null` giữ nguyên là SQL NULL như đường Drizzle), điều
 * kiện động của `listAudit` dựng bằng `.where` xâu chuỗi trên
 * builder giữ lại (mẫu an toàn của thử nghiệm T-13 — không bao
 * giờ truyền `where(undefined)`). Repository không import từ
 * `apps/*`, không đọc ALS/ngữ cảnh ứng dụng, không tự mở pool.
 */
import { sql, type RawBuilder } from 'kysely';
import type { CentreDb } from '../client';
import type { Json } from '../types/centre-db';

/** Một dòng vết thay đổi cấu hình do quản trị thực hiện (hình dạng camelCase phía tiêu thụ dùng). */
export interface AuditRow {
  id: string;
  settingKey: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string | null;
  /** NULL = thay đổi ở tầng platform; có giá trị = đổi cấu hình tenant (TENANT-0, #168). */
  tenantId: string | null;
  createdAt: Date;
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh —
 * cùng mẫu `jsonbValue` của pilot kho control plane: serialize
 * tường minh + ép kiểu `::jsonb` cho MỌI giá trị jsonb khi ghi
 * (object lẫn mảng) để một khuôn duy nhất, không phụ thuộc nhánh
 * xử lý riêng của driver theo hình dạng giá trị. Kiểu trả về gắn
 * theo kiểu `Json` của cột đích để builder chấp nhận biểu thức ở
 * vị trí giá trị của cột jsonb.
 */
function jsonbValue(value: unknown): RawBuilder<Json> {
  return sql<Json>`${JSON.stringify(value as Json)}::jsonb`;
}

/** Giá trị jsonb sẽ ghi: `null`/vắng mặt giữ là SQL NULL như đường Drizzle, còn lại serialize qua `jsonbValue`. */
function storedJsonb(value: unknown): RawBuilder<Json> | null {
  return value === null || value === undefined ? null : jsonbValue(value);
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng vết thay đổi cấu hình. */
const AUDIT_COLUMNS = [
  'id',
  'setting_key as settingKey',
  'old_value as oldValue',
  'new_value as newValue',
  'changed_by as changedBy',
  'tenant_id as tenantId',
  'created_at as createdAt',
] as const;

/**
 * Kho dữ liệu cấu hình site: hai bảng có sẵn của tầng hạ tầng — `config`
 * cho setting của core (giá trị JSON) và `plugin_config` cho setting theo
 * component/plugin (giá trị text chứa JSON), kèm bảng vết
 * `admin_setting_audit` ghi mọi thay đổi do quản trị thực hiện.
 */
export class SiteConfigRepository {
  constructor(private readonly handle: CentreDb) {}

  /**
   * Đọc giá trị đã lưu trong cơ sở dữ liệu của một setting; undefined nếu
   * chưa từng có ghi đè (khi đó giá trị hiệu lực là mặc định trong code).
   */
  async getStoredValue(component: string, name: string): Promise<unknown> {
    if (component === 'core') {
      const row = await this.handle
        .selectFrom('config')
        .select(['value'])
        .where('key', '=', name)
        .executeTakeFirst();
      return row ? row.value : undefined;
    }
    const row = await this.handle
      .selectFrom('plugin_config')
      .select(['value'])
      .where('plugin', '=', component)
      .where('name', '=', name)
      .where('tenant_id', 'is', null)
      .executeTakeFirst();
    if (!row || row.value === null) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return row.value;
    }
  }

  /**
   * Ghi đè giá trị của một setting (chèn mới hoặc cập nhật dòng đã có).
   *
   * Nhánh plugin là upsert từng phần ở tầng platform: đích xung
   * đột `(plugin, name)` kèm vị từ `tenant_id is null` của chỉ số
   * duy nhất riêng phần (xem mô tả ở đầu file) — vị từ khai bằng
   * `.where(...)` trên builder xung đột TRƯỚC `doUpdateSet`. Nhờ
   * vậy một dòng tenant trùng `(plugin, name)` không bao giờ bị
   * nhánh ghi platform chạm tới, và dòng platform đã có được cập
   * nhật thay vì vấp ràng buộc duy nhất.
   */
  async storeValue(component: string, name: string, value: unknown): Promise<void> {
    if (component === 'core') {
      const stored = storedJsonb(value);
      await this.handle
        .insertInto('config')
        .values({ key: name, value: stored })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: stored, updated_at: new Date() }))
        .execute();
      return;
    }
    await this.handle
      .insertInto('plugin_config')
      .values({ plugin: component, name, value: JSON.stringify(value) })
      .onConflict((oc) => oc
        .columns(['plugin', 'name'])
        .where('tenant_id', 'is', null)
        .doUpdateSet({ value: JSON.stringify(value) }))
      .execute();
  }

  /**
   * Xoá ghi đè của một setting để giá trị hiệu lực trở về mặc định code.
   */
  async deleteValue(component: string, name: string): Promise<void> {
    if (component === 'core') {
      await this.handle.deleteFrom('config').where('key', '=', name).execute();
      return;
    }
    await this.handle
      .deleteFrom('plugin_config')
      .where('plugin', '=', component)
      .where('name', '=', name)
      .where('tenant_id', 'is', null)
      .execute();
  }

  /**
   * Ghi một dòng vết thay đổi: khoá setting, giá trị trước, giá trị sau và
   * người thực hiện.
   */
  async insertAudit(entry: {
    settingKey: string;
    oldValue: unknown;
    newValue: unknown;
    changedBy: string;
    /** NULL = thay đổi ở tầng platform; có giá trị = đổi cấu hình tenant (TENANT-0, #168). */
    tenantId?: string | null;
  }): Promise<void> {
    await this.handle
      .insertInto('admin_setting_audit')
      .values({
        setting_key: entry.settingKey,
        old_value: storedJsonb(entry.oldValue ?? null),
        new_value: storedJsonb(entry.newValue ?? null),
        changed_by: entry.changedBy,
        tenant_id: entry.tenantId ?? null,
      })
      .execute();
  }

  /**
   * Liệt kê vết thay đổi mới nhất trước; lọc theo khoá setting nếu có.
   *
   * Điều kiện lọc là điều kiện động theo mẫu T-13: builder được
   * giữ lại và `.where` chỉ được xâu thêm khi có khoá lọc — không
   * truyền `undefined` vào `where` (nó bị gắn thành NULL và lặng
   * lẽ trả 0 dòng).
   */
  async listAudit(settingKey?: string): Promise<AuditRow[]> {
    let query = this.handle.selectFrom('admin_setting_audit').select(AUDIT_COLUMNS);
    if (settingKey) {
      query = query.where('setting_key', '=', settingKey);
    }
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows as AuditRow[];
  }
}
