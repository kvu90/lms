/**
 * Helper THUẦN dựng các câu lệnh ĐẢM BẢO 3 bảng vệ tinh của Ngân hàng
 * hệ thống tồn tại trong KHO NGHIỆP VỤ (issue #585): tách phần dựng
 * câu SQL khỏi phần thực thi (script
 * `system-bank-centre-tables-setup.ts`) để kiểm chứng bằng unit test
 * không cần database thật. Theo mẫu `system-bank-provision.ts` cùng
 * module.
 *
 * Vì sao cần bước ensure này (vòng sửa theo phán quyết trên PR #612):
 * - Ba bảng vệ tinh — `system_question_imports` (dòng nhập bản chụp +
 *   truy vết nguồn), `system_bank_event_receipts` (vết trung tâm đã
 *   nhận sự kiện) và `outcome_package_installs` (vết bản cài gói
 *   YCCĐ) — sống trong kho nghiệp vụ của trung tâm, được khai trong
 *   schema `@lms/db` và được tạo bởi file baseline
 *   `packages/db/migrations/centre/20261025163710_baseline/migration.sql`.
 * - Ba bảng được NỐI VÀO CUỐI file baseline sau khi baseline đã phát
 *   hành. Drizzle bỏ qua cả thư mục baseline trên các database đã áp
 *   nó (production, preview), nên các database đó KHÔNG bao giờ nhận
 *   được 3 bảng qua đường migration — trong khi luồng sửa câu hỏi
 *   (`QuestionsService`) cập nhật `system_question_imports` trong
 *   cùng transaction của MỌI lần sửa câu: bảng vắng là mọi lần sửa
 *   câu đều gãy, không riêng tính năng ngân hàng.
 * - Bước ensure bù đúng phần đó: chạy trong chuỗi migrate NGAY SAU
 *   migration của kho nghiệp vụ, tạo đúng những gì còn thiếu. Mọi câu
 *   đều idempotent (`IF NOT EXISTS`, khoá ngoại canh bằng tra cứu
 *   `pg_constraint`) nên trên database mới (baseline đã tạo đủ) bước
 *   này là no-op, và chạy lặp ở mỗi lần stack khởi động là an toàn.
 *
 * Kỷ luật đồng bộ: nội dung DDL ở đây (cột, ràng buộc, tên index,
 * khoá ngoại) PHẢI khớp từng chữ với khối tạo 3 bảng ở cuối file
 * baseline — đổi schema của bảng vệ tinh thì sửa cả hai nơi trong
 * cùng một lượt. Bảng tạo bởi role migration được role runtime thừa
 * hưởng quyền dữ kiện qua `ALTER DEFAULT PRIVILEGES` (issue #586)
 * nên tầng ứng dụng dùng được ngay, không cần bước cấp quyền riêng.
 */

/**
 * Các câu lệnh đảm bảo 3 bảng vệ tinh tồn tại trong kho nghiệp vụ,
 * theo thứ tự: tạo bảng → tạo index → gắn khoá ngoại (khoá ngoại của
 * `system_question_imports` trỏ `question(id)` nên phải đứng sau khi
 * cả bảng vệ tinh lẫn bảng `question` của baseline đã có mặt).
 * Mọi câu đều chạy lặp an toàn.
 */
export function buildCentreSatelliteEnsureStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS "outcome_package_installs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"package_version" text NOT NULL,
	"previous_version" text,
	"scope" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by" uuid
)`,
    `CREATE TABLE IF NOT EXISTS "system_bank_event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"event_id" uuid NOT NULL,
	"centre_slug" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_bank_event_receipts_event_centre_unique" UNIQUE("event_id","centre_slug")
)`,
    `CREATE TABLE IF NOT EXISTS "system_question_imports" (
	"question_id" uuid PRIMARY KEY,
	"source_question_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"source_version_number" integer NOT NULL,
	"package_checksum" text NOT NULL,
	"imported_version_number" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" uuid,
	"kind" text DEFAULT 'pristine' NOT NULL,
	CONSTRAINT "system_question_imports_kind_check" CHECK ("kind" in ('pristine', 'derived'))
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "outcome_package_installs_package_version_unique" ON "outcome_package_installs" ("package_version")`,
    `CREATE INDEX IF NOT EXISTS "system_bank_event_receipts_centre_slug_idx" ON "system_bank_event_receipts" ("centre_slug")`,
    `CREATE INDEX IF NOT EXISTS "system_question_imports_source_question_id_idx" ON "system_question_imports" ("source_question_id")`,
    `DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_question_imports_question_id_question_id_fkey' AND conrelid = '"system_question_imports"'::regclass) THEN
		ALTER TABLE "system_question_imports" ADD CONSTRAINT "system_question_imports_question_id_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE;
	END IF;
END $$`,
  ];
}
