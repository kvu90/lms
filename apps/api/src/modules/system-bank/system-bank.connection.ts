/**
 * Kết nối tới database kho ngân hàng hệ thống (issue #585) — theo mẫu
 * `ControlPlaneConnection` của issue #580.
 *
 * Từ hạng mục nhân rộng G10 (issue #650), lớp này là ADAPTER mỏng
 * như adapter của pilot kho control plane: nó chỉ còn làm hai việc
 * của tầng ứng dụng — đọc cấu hình môi trường và sở hữu vòng đời
 * của `pg.Pool` — rồi cấp pool cho factory
 * `createSystemBankKysely` của `@lms/db`; mọi truy cập dữ liệu đi
 * qua handle Kysely (`kysely`) và repository của package. Pool
 * KHÔNG bị đóng qua `destroy()` của instance Kysely (hàm đó cũng
 * đóng pool): điểm đóng duy nhất là `onModuleDestroy` của adapter
 * này, như đường kết nối trước đây.
 *
 * Khác hẳn kết nối nghiệp vụ ở hai điểm có chủ đích:
 * - Pool THƯỜNG của `pg`, không qua `TenantAwarePool`: dữ liệu kho
 *   ngân hàng là dữ liệu của platform, không thuộc tenant nào, không
 *   có RLS theo tenant để áp; gác quyền nằm ở tầng service.
 * - Kết nối có thể VẮNG: hệ chưa cấu hình `SYSTEM_BANK_DATABASE_URL`
 *   thì `kysely` bằng null và ứng dụng vẫn khởi động như cũ (chuỗi
 *   migrate trong compose.yaml cũng bỏ qua bước cấp phát + migration
 *   kho ngân hàng khi biến chưa đặt). Mọi điểm dùng phải hỏi
 *   `isConfigured` trước — service của module ném lỗi
 *   `system_bank.not_configured` khi bị gọi trong trạng thái chưa cấu
 *   hình.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSystemBankKysely, type SystemBankDb } from '@lms/db/system-bank';
import { Pool } from 'pg';
import { databaseConnectionFromEnv } from '../../config/env';

@Injectable()
export class SystemBankConnection implements OnModuleDestroy {
  /** Handle Kysely của kho ngân hàng; null khi chưa cấu hình biến môi trường. */
  readonly kysely: SystemBankDb | null;
  private readonly pool: Pool | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('SYSTEM_BANK_DATABASE_URL');
    if (!url) {
      this.kysely = null;
      this.pool = null;
      return;
    }
    const connection = databaseConnectionFromEnv(url, config.get<boolean>('DATABASE_SSL') ?? false);
    const poolConfig = typeof connection === 'string' ? { connectionString: connection } : connection;
    this.pool = new Pool(poolConfig);
    this.kysely = createSystemBankKysely(this.pool);
  }

  /** Kho ngân hàng đã được cấu hình kết nối hay chưa. */
  get isConfigured(): boolean {
    return this.kysely !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
