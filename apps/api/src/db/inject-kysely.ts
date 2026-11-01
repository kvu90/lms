/**
 * Decorator `@InjectKysely(...)` — cơ chế inject handle Kysely tự
 * dựng của repo, thay vai trò mà `@InjectDrizzle` của package ngoài
 * `@nestjs/drizzle` đang giữ cho phía Drizzle.
 *
 * Vì sao tự dựng: Kysely không có module NestJS chính thức và dự án
 * không lấy thêm package cộng đồng cho việc này (xem `KyselyModule`
 * trong `kysely.module.ts` cùng thư mục). Mỗi kho dữ liệu có một
 * token riêng; `InjectKysely()` không tham số trỏ về kho trung tâm —
 * kho mặc định, tương đương cách `@InjectDrizzle()` trỏ về kết nối
 * mặc định hiện nay.
 */
import { Inject } from '@nestjs/common';

/** Ba kho dữ liệu có handle Kysely — khớp ba factory trong `@lms/db` (`client.ts`). */
export type KyselyStoreName = 'centre' | 'control-plane' | 'system-bank';

/** Token provider của handle Kysely kho trung tâm (`CentreDb`). */
export const KYSELY_CENTRE = 'KYSELY_CENTRE';

/** Token provider của handle Kysely kho control plane (`ControlPlaneDb`). */
export const KYSELY_CONTROL_PLANE = 'KYSELY_CONTROL_PLANE';

/** Token provider của handle Kysely kho ngân hàng hệ thống (`SystemBankDb`). */
export const KYSELY_SYSTEM_BANK = 'KYSELY_SYSTEM_BANK';

const STORE_TOKENS: Record<KyselyStoreName, string> = {
  centre: KYSELY_CENTRE,
  'control-plane': KYSELY_CONTROL_PLANE,
  'system-bank': KYSELY_SYSTEM_BANK,
};

/**
 * Inject handle Kysely của một kho vào constructor.
 *
 * @param store - Kho cần handle; mặc định là kho trung tâm.
 * @returns Decorator tham số của NestJS (`Inject` với token của kho).
 *
 * @example
 * ```ts
 * constructor(@InjectKysely() private readonly db: CentreDb) {}
 * constructor(@InjectKysely('control-plane') private readonly cp: ControlPlaneDb) {}
 * ```
 */
export function InjectKysely(store: KyselyStoreName = 'centre'): ParameterDecorator {
  return Inject(STORE_TOKENS[store]);
}
