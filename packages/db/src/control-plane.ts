/**
 * Điểm vào riêng của kho CONTROL PLANE (issue #580): factory
 * handle Kysely của kho này + hai kiểu jsonb nghiệp vụ của nó.
 * Kho control plane là một database riêng với bộ migration riêng
 * (xem `src/migrate/stores.ts`) nên điểm vào tách khỏi barrel gốc
 * của kho trung tâm — hai kho, hai điểm vào, không trộn kiểu.
 */
export {
  createControlPlaneKysely,
  type ControlPlaneDB,
  type ControlPlaneDb,
  type ControlPlaneTx,
} from './client';
export type { SchemaMigrationStep, SpaceRegistrySnapshot } from './jsonb-types';
