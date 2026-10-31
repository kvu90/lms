/**
 * Unit test cho helper đảm bảo 3 bảng vệ tinh của Ngân hàng hệ
 * thống trong kho nghiệp vụ (issue #585): kiểm chứng phần dựng câu
 * SQL thuần — đủ 3 bảng, mọi câu đều idempotent, nội dung DDL khớp
 * khối tạo bảng ở cuối file baseline — không cần database thật.
 * Tính idempotent khi chạy trên database thật (kể cả database đã áp
 * baseline cũ) được khoá ở bước kiểm chứng triển khai của vòng sửa.
 */
import { describe, expect, it } from 'vitest';
import { buildCentreSatelliteEnsureStatements } from './system-bank-centre-tables';

describe('Đảm bảo bảng vệ tinh Ngân hàng hệ thống — dựng câu lệnh SQL', () => {
  it('dựng đúng 7 câu theo thứ tự tạo bảng, tạo index, gắn khoá ngoại', () => {
    const statements = buildCentreSatelliteEnsureStatements();
    expect(statements).toHaveLength(7);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS "outcome_package_installs"');
    expect(statements[1]).toContain('CREATE TABLE IF NOT EXISTS "system_bank_event_receipts"');
    expect(statements[2]).toContain('CREATE TABLE IF NOT EXISTS "system_question_imports"');
    expect(statements[3]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "outcome_package_installs_package_version_unique"');
    expect(statements[4]).toContain('CREATE INDEX IF NOT EXISTS "system_bank_event_receipts_centre_slug_idx"');
    expect(statements[5]).toContain('CREATE INDEX IF NOT EXISTS "system_question_imports_source_question_id_idx"');
    expect(statements[6]).toContain('ALTER TABLE "system_question_imports" ADD CONSTRAINT "system_question_imports_question_id_question_id_fkey"');
  });

  it('mọi câu tạo bảng và tạo index đều mang IF NOT EXISTS để chạy lặp không lỗi', () => {
    const statements = buildCentreSatelliteEnsureStatements();
    for (const statement of statements.slice(0, 6)) {
      expect(statement).toContain('IF NOT EXISTS');
    }
  });

  it('giữ đúng ràng buộc nghiệp vụ của baseline: kind chỉ nhận pristine/derived, vết nhận sự kiện duy nhất theo cặp sự kiện + trung tâm', () => {
    const statements = buildCentreSatelliteEnsureStatements();
    expect(statements[2]).toContain(
      `CONSTRAINT "system_question_imports_kind_check" CHECK ("kind" in ('pristine', 'derived'))`,
    );
    expect(statements[1]).toContain(
      'CONSTRAINT "system_bank_event_receipts_event_centre_unique" UNIQUE("event_id","centre_slug")',
    );
    expect(statements[0]).toContain('"id" uuid PRIMARY KEY DEFAULT uuidv7()');
    expect(statements[2]).toContain('"question_id" uuid PRIMARY KEY');
  });

  it('khoá ngoại được canh bằng tra cứu pg_constraint theo đúng tên constraint và trỏ về question(id) kèm ON DELETE CASCADE', () => {
    const fk = buildCentreSatelliteEnsureStatements()[6]!;
    expect(fk).toContain('DO $$ BEGIN');
    expect(fk).toContain("FROM pg_constraint WHERE conname = 'system_question_imports_question_id_question_id_fkey'");
    expect(fk).toContain('FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE CASCADE');
    expect(fk).toContain('END $$');
  });
});
