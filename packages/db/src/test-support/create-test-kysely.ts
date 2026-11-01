/**
 * Điểm vào dựng handle Kysely cho test: bọc ba factory production
 * trong `client.ts` để spec lấy cả ba handle của ba kho trên pool
 * được cấp, không lặp lại việc gắn dialect ở từng spec.
 *
 * Pool quyết định kho thật được chạm tới: spec dựng database test
 * của kho nào bằng `buildTestDatabase` thì tạo pool trỏ tới database
 * đó rồi dùng đúng handle của kho tương ứng trong bộ ba trả về (hai
 * handle còn lại chỉ là view kiểu trên cùng pool, spec không dùng).
 */
import type { Pool } from 'pg';
import {
  createCentreKysely,
  createControlPlaneKysely,
  createSystemBankKysely,
  type CentreDb,
  type ControlPlaneDb,
  type SystemBankDb,
} from '../client';

/** Bộ ba handle Kysely của ba kho trên cùng một pool test. */
export interface TestKysely {
  centre: CentreDb;
  controlPlane: ControlPlaneDb;
  systemBank: SystemBankDb;
}

/** Dựng bộ ba handle Kysely trên `pool` bằng đúng factory production. */
export function createTestKysely(pool: Pool): TestKysely {
  return {
    centre: createCentreKysely(pool),
    controlPlane: createControlPlaneKysely(pool),
    systemBank: createSystemBankKysely(pool),
  };
}
