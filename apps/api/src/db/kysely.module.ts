/**
 * `KyselyModule` — wiring NestJS tự dựng cho các handle Kysely, thay
 * vai trò mà `DrizzleModule.forRootAsync` của `@nestjs/drizzle` đang
 * giữ cho phía Drizzle.
 *
 * Vì sao tự dựng: Kysely không phát hành module NestJS chính thức;
 * pattern được nhà phát hành tài liệu hoá là tự tạo provider giữ
 * instance `Kysely` được dựng bằng factory của dự án. Module này
 * bám đúng khuôn `forRoot` quen thuộc của hệ:
 *
 *   - `KyselyModule.forRoot({ centre: pool, controlPlane: pool, systemBank: pool })`
 *     nhận các `Pool` do tầng ứng dụng tạo sẵn (pool quyết định ngữ
 *     cảnh kết nối: `TenantAwarePool` cho kho trung tâm để RLS/GUC
 *     hoạt động, pool thường cho hai kho còn lại) và đăng ký một
 *     provider cho mỗi kho được truyền, dùng đúng factory của
 *     `@lms/db` (`createCentreKysely`, `createControlPlaneKysely`,
 *     `createSystemBankKysely`).
 *   - Các service lấy handle bằng `@InjectKysely(...)` (xem
 *     `inject-kysely.ts` cùng thư mục).
 *   - Khi ứng dụng đóng, một provider dọn dẹp gọi `destroy()` trên
 *     mọi instance đã đăng ký — theo hành vi của `PostgresDialect`,
 *     `destroy()` đóng luôn pool đã truyền vào, nên pool truyền cho
 *     `forRoot` thuộc quyền sở hữu của module từ thời điểm đăng ký.
 *
 * Trạng thái ở hạng mục nền: module và decorator đã dựng xong và có
 * spec tích hợp kiểm chứng, nhưng `AppModule` chưa đăng ký module
 * này — kho đầu tiên có consumer (kho control plane ở pilot) sẽ
 * đăng ký khi chuyển đổi, và handle định tuyến của kho trung tâm
 * thuộc hạng mục nền tiếp theo. Chưa đăng ký nghĩa là hành vi khởi
 * động hiện tại không đổi: không pool phụ nào được mở thêm.
 */
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { createCentreKysely, type CentreDb } from '@lms/db';
import {
  createControlPlaneKysely,
  type ControlPlaneDb,
} from '@lms/db/control-plane';
import { createSystemBankKysely, type SystemBankDb } from '@lms/db/system-bank';
import type { Pool } from 'pg';
import { KYSELY_CENTRE, KYSELY_CONTROL_PLANE, KYSELY_SYSTEM_BANK } from './inject-kysely';

/** Token giữ danh sách mọi instance Kysely đã đăng ký để dọn dẹp khi ứng dụng đóng. */
const KYSELY_INSTANCES = 'KYSELY_INSTANCES';

/**
 * Hình tối thiểu của một instance Kysely mà provider dọn dẹp cần:
 * chỉ thao tác `destroy()`. Khai theo cấu trúc thay vì import kiểu
 * `Kysely` vì package `kysely` là phụ thuộc của `@lms/db`, không
 * phải của `apps/api` — các handle đi vào module đều qua factory
 * của `@lms/db` nên kiểu đầy đủ vẫn được giữ ở nơi khai báo chúng.
 */
type DestroyableKysely = { destroy(): Promise<void> };

/**
 * Provider dọn dẹp vòng đời: gọi `destroy()` trên mọi instance
 * Kysely của module khi ứng dụng đóng, để pool của từng kho được
 * đóng đúng một lần cùng tiến trình.
 */
@Injectable()
class KyselyShutdownService implements OnApplicationShutdown {
  constructor(
    @Inject(KYSELY_INSTANCES)
    private readonly instances: readonly DestroyableKysely[],
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.instances.map((instance) => instance.destroy()));
  }
}

/** Tuỳ chọn của `KyselyModule.forRoot`: pool của từng kho — kho nào không truyền thì không đăng ký handle. */
export interface KyselyModuleOptions {
  /** Pool kho trung tâm — phải là `TenantAwarePool` để GUC/RLS theo ngữ cảnh tenant hoạt động. */
  centre?: Pool;
  /** Pool kho control plane (pool thường, không qua định tuyến tenant). */
  controlPlane?: Pool;
  /** Pool kho ngân hàng hệ thống (pool thường, không qua định tuyến tenant). */
  systemBank?: Pool;
}

@Module({})
export class KyselyModule {
  /**
   * Đăng ký handle Kysely cho các kho có pool trong `options`.
   *
   * @param options - Pool của từng kho do tầng ứng dụng tạo và bàn giao quyền sở hữu.
   * @returns Dynamic module xuất các token handle tương ứng để module khác inject.
   */
  static forRoot(options: KyselyModuleOptions): DynamicModule {
    const instances: DestroyableKysely[] = [];
    const providers: Provider[] = [];
    const exportsList: string[] = [];

    if (options.centre) {
      const centre: CentreDb = createCentreKysely(options.centre);
      instances.push(centre);
      providers.push({ provide: KYSELY_CENTRE, useValue: centre });
      exportsList.push(KYSELY_CENTRE);
    }
    if (options.controlPlane) {
      const controlPlane: ControlPlaneDb = createControlPlaneKysely(options.controlPlane);
      instances.push(controlPlane);
      providers.push({ provide: KYSELY_CONTROL_PLANE, useValue: controlPlane });
      exportsList.push(KYSELY_CONTROL_PLANE);
    }
    if (options.systemBank) {
      const systemBank: SystemBankDb = createSystemBankKysely(options.systemBank);
      instances.push(systemBank);
      providers.push({ provide: KYSELY_SYSTEM_BANK, useValue: systemBank });
      exportsList.push(KYSELY_SYSTEM_BANK);
    }

    providers.push({ provide: KYSELY_INSTANCES, useValue: instances }, KyselyShutdownService);

    return {
      module: KyselyModule,
      providers,
      exports: exportsList,
    };
  }
}
