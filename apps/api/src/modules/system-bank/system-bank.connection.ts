/**
 * Kết nối tới database kho ngân hàng hệ thống (issue #585) — theo mẫu
 * `ControlPlaneConnection` của issue #580.
 *
 * Khác hẳn kết nối nghiệp vụ ở hai điểm có chủ đích:
 * - Pool THƯỜNG của `pg`, không qua `TenantAwarePool`: dữ liệu kho
 *   ngân hàng là dữ liệu của platform, không thuộc tenant nào, không
 *   có RLS theo tenant để áp; gác quyền nằm ở tầng service.
 * - Kết nối có thể VẮNG: hệ chưa cấu hình `SYSTEM_BANK_DATABASE_URL`
 *   thì `db` bằng null và ứng dụng vẫn khởi động như cũ (chuỗi
 *   migrate trong compose.yaml cũng bỏ qua bước cấp phát + migration
 *   kho ngân hàng khi biến chưa đặt). Mọi điểm dùng phải hỏi
 *   `isConfigured` trước — service của module ném lỗi
 *   `system_bank.not_configured` khi bị gọi trong trạng thái chưa cấu
 *   hình.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseConnectionFromEnv } from '../../config/env';

/**
 * Kiểu handle Drizzle của database kho ngân hàng. Không gắn generic
 * schema như handle nghiệp vụ: các bảng kho ngân hàng được import trực
 * tiếp từ `@lms/db/system-bank` ở repository/service (đủ an toàn kiểu
 * cho insert/select), và tầng này không dùng relational query API.
 */
export type SystemBankDatabase = NodePgDatabase;

@Injectable()
export class SystemBankConnection implements OnModuleDestroy {
  /** Handle Drizzle của kho ngân hàng; null khi chưa cấu hình biến môi trường. */
  readonly db: SystemBankDatabase | null;
  private readonly pool: Pool | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('SYSTEM_BANK_DATABASE_URL');
    if (!url) {
      this.db = null;
      this.pool = null;
      return;
    }
    const connection = databaseConnectionFromEnv(url, config.get<boolean>('DATABASE_SSL') ?? false);
    const poolConfig = typeof connection === 'string' ? { connectionString: connection } : connection;
    this.pool = new Pool(poolConfig);
    this.db = drizzle({ client: this.pool });
  }

  /** Kho ngân hàng đã được cấu hình kết nối hay chưa. */
  get isConfigured(): boolean {
    return this.db !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
