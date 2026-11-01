/**
 * Điểm vào test-support của `@lms/db` (điểm vào phụ
 * `@lms/db/test-support` trong `package.json`): harness dựng
 * database test từ rỗng bằng SQL mang dữ liệu, pool test gắn ngữ
 * cảnh tenant theo hợp đồng GUC/RLS của hệ, và hàm dựng handle
 * Kysely cho spec. Chỉ dùng trong test — mã production không import
 * điểm vào này.
 */
export {
  buildTestDatabase,
  dropTestDatabase,
  withDatabase,
  type BuildTestDatabaseOptions,
  type TestStoreKind,
} from './build-test-database';
export { createTestKysely, type TestKysely } from './create-test-kysely';
export {
  runInTestPlatformContext,
  runInTestTenantContext,
  testTenantAls,
  TestTenantPool,
  type TestTenantStore,
} from './tenant-context';
