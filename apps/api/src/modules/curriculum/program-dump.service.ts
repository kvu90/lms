import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { writeFileSync } from 'node:fs';
import type { Database } from '../../db/database';
import { CurriculumRepository } from './curriculum.repository';
import {
  buildProgramDumpSql, loadProgramDumpSql, restoreProgramDumpSql, PROGRAM_DUMP_VERSION,
} from './program-dump';

/**
 * Dịch vụ phân phối dữ liệu chương trình bằng DUMP ĐÔNG CỨNG (chốt
 * 20:09 ngày 26/10/2026, sổ mục E). Hai đầu việc tách bạch:
 * - PHÂN PHỐI (mọi môi trường): {@link restoreIfEmpty} — seed gọi để
 *   restore artifact trong repo khi DB chưa có dữ liệu chương trình.
 * - SẢN XUẤT (chỉ trung tâm): {@link exportDumpToFile} — CLI
 *   export-program-dump gọi trên DB chuẩn đã patch bằng importer.
 * Importer KHÔNG còn chạy trong seed của các môi trường.
 */
@Injectable()
export class ProgramDumpService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly repo: CurriculumRepository,
  ) {}

  /**
   * Restore artifact dump hiện hành nếu DB chưa có dữ liệu chương
   * trình nào (sổ đăng ký trống) — idempotent theo luật seed: DB đã
   * có dữ liệu chương trình thì bỏ qua, không ghi đè, không nhân đôi.
   *
   * @returns `restored` cho biết lượt này có restore thật hay bỏ qua,
   *   kèm version của artifact trong repo để log seed đối chiếu.
   */
  async restoreIfEmpty(): Promise<{ restored: boolean; version: string }> {
    const existing = await this.repo.countProgramRecords();
    if (existing > 0) return { restored: false, version: PROGRAM_DUMP_VERSION };
    await restoreProgramDumpSql(this.db, loadProgramDumpSql());
    return { restored: true, version: PROGRAM_DUMP_VERSION };
  }

  /** Toàn văn dump của DB hiện tại (đường sản xuất ở trung tâm + kiểm chứng dùng chung). */
  async buildDumpSql(): Promise<string> {
    return buildProgramDumpSql(this.db);
  }

  /**
   * Xuất dump của DB hiện tại ra file artifact (đường sản xuất ở
   * trung tâm — CLI export-program-dump; DB nguồn phải là DB chuẩn
   * chỉ chứa dữ liệu chương trình do importer sản xuất).
   *
   * @param filePath - Đường dẫn file SQL đích (trong repo).
   * @returns Version của artifact vừa xuất.
   */
  async exportDumpToFile(filePath: string): Promise<{ version: string }> {
    const dumpSql = await buildProgramDumpSql(this.db);
    writeFileSync(filePath, dumpSql, 'utf8');
    return { version: PROGRAM_DUMP_VERSION };
  }
}
