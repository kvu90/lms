import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { writeFileSync } from 'node:fs';
import type { Database } from '../../db/database';
import { ContextsService } from '../access/contexts.service';
import { CurriculumRepository } from './curriculum.repository';
import {
  buildProgramDumpSql, loadProgramDumpSql, restoreProgramDumpSql, PROGRAM_DUMP_VERSION,
} from './program-dump';

/**
 * Dịch vụ phân phối dữ liệu chương trình bằng DUMP ĐÔNG CỨNG. Hai
 * đầu việc tách bạch:
 * - PHÂN PHỐI (mọi môi trường): {@link restoreIfEmpty} — seed gọi để
 *   restore artifact trong repo khi DB chưa có dữ liệu chương trình.
 * - SẢN XUẤT (chỉ trung tâm): {@link exportDumpToFile} — CLI
 *   export-program-dump gọi trên DB chuẩn đã patch bằng importer.
 * Importer KHÔNG còn chạy trong seed của các môi trường.
 *
 * Mọi đường restore qua service này đều neo lại các môn vừa restore
 * về context hệ thống của CHÍNH môi trường đích (qua
 * `ContextsService.ensureSystemContext` + tham số `anchorContextId`
 * của {@link restoreProgramDumpSql}): literal `subjects.context_id`
 * trong artifact thuộc về môi trường sinh dump, không neo lại thì
 * môi trường đích nhận một cây chương trình không đọc được.
 */
@Injectable()
export class ProgramDumpService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly repo: CurriculumRepository,
    private readonly contexts: ContextsService,
  ) {}

  /**
   * Restore artifact dump hiện hành nếu DB chưa có dữ liệu chương
   * trình nào (sổ đăng ký trống) — idempotent theo luật seed: DB đã
   * có dữ liệu chương trình thì bỏ qua, không ghi đè, không nhân đôi.
   * Lượt restore thật neo các môn về context hệ thống của môi
   * trường này ngay trong cùng transaction với restore (xem
   * {@link restoreProgramDumpSql}).
   *
   * @returns `restored` cho biết lượt này có restore thật hay bỏ qua,
   *   kèm version của artifact trong repo để log seed đối chiếu.
   */
  async restoreIfEmpty(): Promise<{ restored: boolean; version: string }> {
    const existing = await this.repo.countProgramRecords();
    if (existing > 0) return { restored: false, version: PROGRAM_DUMP_VERSION };
    const system = await this.contexts.ensureSystemContext();
    await restoreProgramDumpSql(this.db, loadProgramDumpSql(), { anchorContextId: system.id });
    return { restored: true, version: PROGRAM_DUMP_VERSION };
  }

  /**
   * Toàn văn dump của DB hiện tại (đường sản xuất ở trung tâm xuất
   * toàn bộ; kiểm chứng trong suite dùng chung DB truyền `datasetKey`
   * để giới hạn phạm vi theo một dataset).
   */
  async buildDumpSql(opts?: { datasetKey?: string }): Promise<string> {
    return buildProgramDumpSql(this.db, opts);
  }

  /**
   * Restore một bản dump cho trước vào DB hiện tại (một transaction,
   * kèm neo các môn vừa restore về context hệ thống của môi trường
   * này như {@link restoreIfEmpty}). Đường nội bộ của
   * {@link restoreIfEmpty}; phơi ra cho kiểm chứng vòng xuất →
   * restore trên cùng một artifact vừa sản xuất.
   */
  async restoreDumpSql(dumpSql: string): Promise<void> {
    const system = await this.contexts.ensureSystemContext();
    await restoreProgramDumpSql(this.db, dumpSql, { anchorContextId: system.id });
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
