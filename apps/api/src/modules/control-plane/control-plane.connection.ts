import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseConnectionFromEnv } from '../../config/env';

/**
 * Kiểu handle Drizzle của database control plane. Không gắn generic
 * schema/relations như handle nghiệp vụ: các bảng control plane được
 * import trực tiếp từ `@lms/db/control-plane` ở repository (đủ an
 * toàn kiểu cho insert/select), và tầng này không dùng relational
 * query API.
 */
export type ControlPlaneDatabase = NodePgDatabase;

/**
 * Kết nối tới database CONTROL PLANE (issue #580) — database riêng
 * trên cùng cụm Postgres với kho nghiệp vụ, role kết nối riêng, biến
 * môi trường riêng (`CONTROL_PLANE_DATABASE_URL`).
 *
 * Khác hẳn kết nối nghiệp vụ ở hai điểm có chủ đích:
 * - Pool THƯỜNG của `pg`, không qua `TenantAwarePool`: dữ liệu control
 *   plane là dữ liệu của platform, không thuộc tenant nào, không có
 *   RLS theo tenant để áp; gác quyền nằm ở tầng service.
 * - Trần kết nối lấy từ `CONTROL_PLANE_POOL_MAX` khi được cấu hình
 *   (issue #586 — ngân sách kết nối của cụm, xem `DATABASE_POOL_MAX`
 *   trong `config/env.ts`); chưa cấu hình thì giữ mặc định của thư
 *   viện `pg` như trước.
 * - Kết nối có thể VẮNG: hệ chưa cấu hình biến môi trường thì `db`
 *   bằng null và ứng dụng vẫn khởi động như cũ (môi trường triển khai
 *   bằng compose luôn cấu hình). Mọi điểm dùng phải hỏi `isConfigured`
 *   trước — service của module ném lỗi `control_plane.not_configured`
 *   khi bị gọi trong trạng thái chưa cấu hình.
 */
@Injectable()
export class ControlPlaneConnection implements OnModuleDestroy {
  /** Handle Drizzle của control plane; null khi chưa cấu hình biến môi trường. */
  readonly db: ControlPlaneDatabase | null;
  private readonly pool: Pool | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('CONTROL_PLANE_DATABASE_URL');
    if (!url) {
      this.db = null;
      this.pool = null;
      return;
    }
    const connection = databaseConnectionFromEnv(url, config.get<boolean>('DATABASE_SSL') ?? false);
    const poolConfig = typeof connection === 'string' ? { connectionString: connection } : connection;
    const poolMax = config.get<number>('CONTROL_PLANE_POOL_MAX');
    this.pool = new Pool(poolMax ? { ...poolConfig, max: poolMax } : poolConfig);
    this.db = drizzle({ client: this.pool });
  }

  /** Control plane đã được cấu hình kết nối hay chưa. */
  get isConfigured(): boolean {
    return this.db !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
