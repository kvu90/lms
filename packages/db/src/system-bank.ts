/**
 * Điểm vào riêng của kho NGÂN HÀNG HỆ THỐNG (issue #585): factory
 * handle Kysely của kho này. Kho ngân hàng là một database riêng
 * với bộ migration riêng (xem `src/migrate/stores.ts`) nên điểm
 * vào tách khỏi barrel gốc của kho trung tâm — hai kho, hai điểm
 * vào, không trộn kiểu.
 */
export {
  createSystemBankKysely,
  type SystemBankDB,
  type SystemBankDb,
  type SystemBankTx,
} from './client';
