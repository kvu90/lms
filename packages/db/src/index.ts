/**
 * Điểm vào gốc của `@lms/db` cho kho TRUNG TÂM: factory handle
 * Kysely + hàm đọc nhật ký migration + các kiểu jsonb nghiệp vụ.
 *
 * Từ issue #663 (gỡ bộ máy cũ khỏi cây mã), package không còn lớp
 * schema khai bảng: hình dạng bảng đến từ kiểu sinh bởi
 * `kysely-codegen` trên database thật (`src/types/centre-db.d.ts`,
 * cổng chống lệch `db:types` trong CI), và mọi truy cập dữ kiện đi
 * qua handle Kysely (`client.ts`) cùng các repository trong
 * `src/repositories/`. Phần GHI của bộ máy migration (trình tự áp
 * dùng chung, runner CLI) được tiêu thụ qua điểm vào
 * `@lms/db/migrate` và file `dist/migrate/run.js`, không qua
 * barrel này.
 */
export { createCentreKysely, type CentreDB, type CentreDb, type CentreTx } from './client';
export type { ExamVariant, LearningOutcomeDoc, LearningOutcomeDocNode } from './jsonb-types';
/**
 * Hàm đọc nhật ký migration cho fleet/provision (issue #639): đọc
 * tập tên/phiên bản đã áp của một database qua `pg.Client` từ
 * nhật ký `kysely_migration` của chính database đó (mọi kho sống
 * đều đã qua bước cấy nhật ký ở các PR trước của chiến dịch; bước
 * cấy và đường đọc dự phòng nhật ký cũ đã gỡ cùng issue #663 —
 * xem `migrate/journal.ts`).
 */
export {
  getAppliedMigrations,
  getLatestAppliedMigration,
  type MigrationJournalClient,
} from './migrate/journal';
/**
 * Re-export `sql` của Kysely qua barrel của package: các app tiêu
 * thụ (api, worker) phụ thuộc `@lms/db`, không phụ thuộc trực tiếp
 * package `kysely` — mọi bề mặt Kysely mà app cần (kể cả mẫu SQL
 * thô để gắn GUC trong transaction) đều đi qua điểm vào này, giữ
 * nguyên kỷ luật phụ thuộc đã chốt ở PR-N1. Từ issue #648, barrel
 * còn re-export ba kiểu thuần của Kysely (`RawBuilder`,
 * `Selectable`, `SqlBool`) cho các service phía app còn giữ truy
 * vấn qua handle của repository package (backup, search): kiểu
 * đi qua cùng một điểm vào, app vẫn không khai phụ thuộc trực
 * tiếp vào `kysely` ở cả tầng runtime lẫn tầng kiểu. `JsonValue`
 * không phải kiểu của Kysely: đó là kiểu JSON do codegen sinh trong
 * `types/centre-db`, được barrel re-export từ đúng nguồn đó để các
 * app dùng chung một định nghĩa với các repository.
 */
export { sql, type RawBuilder, type Selectable, type SqlBool } from 'kysely';
export type { JsonValue } from './types/centre-db';
