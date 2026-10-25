import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProgramDatasetStatus, ProgramImportResult } from '@lms/contracts';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CurriculumRepository, type CurriculumNodeRow } from './curriculum.repository';
import { CURRICULUM_MANAGE, CURRICULUM_VIEW } from './curriculum.service';
import {
  loadProgramDataset, programDatasetByKey, programRecordAncestors, programRecordEffectiveGrade, programRecordHash,
  programRecordOutcomeTexts, programRecordSourceRef, programRecordTitle, PROGRAM_DATASETS, type ProgramDatasetDef, type ProgramRecord,
} from './program-datasets';

/**
 * Chỉ mục cây trong bộ nhớ cho một chương trình trong một lượt nạp:
 * tìm node con theo (cha, kind, tựa) và cấp position tiếp theo cho từng
 * cha — nạp theo đúng thứ tự dataset nên cây dựng ra giữ nguyên thứ tự
 * của văn bản chương trình.
 */
interface TreeIndex {
  childByKey: Map<string, CurriculumNodeRow>;
  nextPosByParent: Map<string, number>;
}

function childKey(parentId: string | null, kind: string, title: string): string {
  return `${parentId ?? ''}|${kind}|${title}`;
}

@Injectable()
/**
 * Cơ chế nạp dữ liệu chương trình chuẩn cấp hệ thống (K0a): chuyển các
 * bản ghi đã kiểm chứng nguyên văn (dataset vendor trong repo) vào cây
 * chương trình ở context hệ thống.
 *
 * Idempotent theo sổ đăng ký `curriculum_program_records`: khoá là
 * (dataset, mã bản ghi); hash nội dung khớp → bỏ qua, lệch → cập nhật.
 * Mỗi bản ghi được ghi trong một transaction riêng (node + YCCĐ + dòng
 * sổ commit nguyên tử) nên lượt nạp chết giữa chừng chạy lại an toàn:
 * phần đã xong được bỏ qua, phần dở được làm nốt, không nhân đôi.
 * Khoá mutex trong tiến trình theo dataset chặn hai lượt nạp trùng
 * nhau (API chạy một instance; nạp là thao tác quản trị hiếm).
 */
export class ProgramImportService {
  private readonly running = new Set<string>();

  constructor(
    private readonly repo: CurriculumRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  /** Trạng thái nạp của mọi dataset trong manifest (đọc cần curriculum:view tại context hệ thống). */
  async listDatasetStatus(actorId: string): Promise<ProgramDatasetStatus[]> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, sys.id);
    const out: ProgramDatasetStatus[] = [];
    for (const def of PROGRAM_DATASETS) {
      const file = loadProgramDataset(def);
      const rows = await this.repo.listProgramRecords(def.key);
      const subject = await this.repo.getSubjectBySlug(def.slug);
      const last = rows.reduce<Date | null>((acc, r) => (acc === null || r.updatedAt > acc ? r.updatedAt : acc), null);
      out.push({
        datasetKey: def.key,
        subjectName: def.subjectName,
        slug: def.slug,
        // Khối trình bày ở trạng thái: chỉ các khối có bản ghi gắn khối
        // tường minh (bản ghi theo cấp grade=null không liệt kê ở đây).
        grades: [...new Set(file.records.map((r) => r.grade))].filter((g): g is number => g !== null).sort((a, b) => a - b),
        totalRecords: file.records.length,
        importedRecords: rows.length,
        subjectId: subject?.id ?? null,
        lastImportedAt: last ? last.toISOString() : null,
      });
    }
    return out;
  }

  /**
   * Nạp (hoặc nạp lại) một dataset theo khoá. Cần curriculum:manage tại
   * context hệ thống. Trả đếm tạo mới / cập nhật / bỏ qua để trang quản
   * trị hiển thị và để đối chiếu với tổng số bản ghi của dataset.
   */
  async importDataset(actorId: string, datasetKey: string): Promise<ProgramImportResult> {
    const def = programDatasetByKey(datasetKey);
    if (!def) {
      throw new NotFoundException({ message: `Program dataset ${datasetKey} is not in the manifest`, code: 'curriculum.program_dataset_not_found' });
    }
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, sys.id);
    if (this.running.has(def.key)) {
      throw new ConflictException({ message: `Import of dataset ${def.key} is already running`, code: 'curriculum.program_import_in_progress' });
    }
    this.running.add(def.key);
    try {
      return await this.runImport(def, sys.id);
    } finally {
      this.running.delete(def.key);
    }
  }

  private async runImport(def: ProgramDatasetDef, systemContextId: string): Promise<ProgramImportResult> {
    const file = loadProgramDataset(def);
    if (file.records.length === 0) {
      throw new BadRequestException({ message: `Program dataset ${def.key} has no records`, code: 'curriculum.program_dataset_empty' });
    }
    // Môn đích ở context hệ thống: tìm theo slug, chưa có thì tạo.
    let subject = await this.repo.getSubjectBySlug(def.slug);
    if (!subject) {
      subject = await this.repo.insertSubject({
        contextId: systemContextId,
        name: def.subjectName,
        slug: def.slug,
        position: PROGRAM_DATASETS.indexOf(def) + 1,
      });
    }
    // Chương trình theo khối: tìm theo cặp (môn, khối), chưa có thì tạo.
    // Khối xét theo khối HIỆU LỰC của bản ghi (bản ghi theo cấp
    // grade=null neo vào khối đầu của cấp — xem programRecordEffectiveGrade).
    const curricula = new Map<number, string>();
    for (const row of await this.repo.listCurricula(subject.id)) curricula.set(row.grade, row.id);
    for (const grade of new Set(file.records.map((r) => programRecordEffectiveGrade(file.records, r)))) {
      if (!curricula.has(grade)) {
        const created = await this.repo.insertCurriculum({ subjectId: subject.id, grade });
        curricula.set(grade, created.id);
      }
    }
    // Chỉ mục cây theo chương trình, dựng lười khi gặp bản ghi đầu tiên của khối.
    const indexes = new Map<string, TreeIndex>();
    const indexFor = async (curriculumId: string): Promise<TreeIndex> => {
      const existing = indexes.get(curriculumId);
      if (existing) return existing;
      const nodes = await this.repo.listNodes(curriculumId);
      const index: TreeIndex = { childByKey: new Map(), nextPosByParent: new Map() };
      for (const node of nodes) {
        index.childByKey.set(childKey(node.parentId, node.kind, node.title), node);
        const key = node.parentId ?? '';
        index.nextPosByParent.set(key, Math.max(index.nextPosByParent.get(key) ?? 1, node.position + 1));
      }
      indexes.set(curriculumId, index);
      return index;
    };

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let outcomesWritten = 0;
    for (const record of file.records) {
      const curriculumId = curricula.get(programRecordEffectiveGrade(file.records, record))!;
      const index = await indexFor(curriculumId);
      const parent = await this.ensureAncestors(index, curriculumId, record);
      // Đường tổ tiên có thể rỗng (dataset không mang bậc cấu trúc nào,
      // ví dụ Âm nhạc): node lesson nằm ngay ở gốc cây của khối.
      const parentId = parent?.id ?? null;
      // Tựa node: nguyên văn content; bản ghi requirement content rỗng
      // thì suy xuống topic/section (xem programRecordTitle).
      const title = programRecordTitle(record);
      const hash = programRecordHash(record);
      const reg = await this.repo.getProgramRecord(def.key, record.id);
      if (reg && reg.contentHash === hash) {
        skipped += 1;
        continue;
      }
      const outcomeTexts = programRecordOutcomeTexts(record);
      const sourceRef = programRecordSourceRef(record);
      if (!reg) {
        const position = this.takePosition(index, parentId);
        await this.repo.dbHandle.transaction(async (tx) => {
          const lesson = await this.repo.insertNode({
            curriculumId, parentId, title, kind: 'lesson', position,
          }, tx as never);
          for (const [i, text] of outcomeTexts.entries()) {
            await this.repo.insertOutcome({
              nodeId: lesson.id, content: text, position: i + 1, sourceKind: 'program', sourceRef, derivedFromId: null,
            }, tx as never);
          }
          await this.repo.insertProgramRecord({
            datasetKey: def.key, recordId: record.id, subjectId: subject.id,
            curriculumId, nodeId: lesson.id, contentHash: hash, source: record.source,
          }, tx as never);
          index.childByKey.set(childKey(parentId, 'lesson', title), lesson);
        });
        created += 1;
        outcomesWritten += outcomeTexts.length;
        continue;
      }
      // Bản ghi đã nạp nhưng dataset đã đính chính (hash lệch): cập nhật
      // node + thay toàn bộ YCCĐ; đổi khối thì xoá node ở chương trình cũ
      // và tạo lại ở chương trình mới (sổ trỏ sang node mới).
      await this.repo.dbHandle.transaction(async (tx) => {
        let lessonId = reg.nodeId;
        if (reg.curriculumId !== curriculumId) {
          await this.repo.deleteNode(reg.nodeId, tx as never);
          const position = this.takePosition(index, parentId);
          const lesson = await this.repo.insertNode({
            curriculumId, parentId, title, kind: 'lesson', position,
          }, tx as never);
          lessonId = lesson.id;
          index.childByKey.set(childKey(parentId, 'lesson', title), lesson);
        } else {
          const current = await this.repo.getNode(reg.nodeId);
          const patch: { title: string; parentId?: string | null; position?: number } = { title };
          if (current && current.parentId !== parentId) {
            patch.parentId = parentId;
            patch.position = this.takePosition(index, parentId);
          }
          await this.repo.updateNode(reg.nodeId, patch, tx as never);
        }
        await this.repo.deleteOutcomesForNode(lessonId, tx as never);
        for (const [i, text] of outcomeTexts.entries()) {
          await this.repo.insertOutcome({
            nodeId: lessonId, content: text, position: i + 1, sourceKind: 'program', sourceRef, derivedFromId: null,
          }, tx as never);
        }
        await this.repo.updateProgramRecord(reg.id, {
          subjectId: subject.id, curriculumId, nodeId: lessonId, contentHash: hash, source: record.source,
        }, tx as never);
      });
      updated += 1;
      outcomesWritten += outcomeTexts.length;
    }
    return {
      datasetKey: def.key,
      subjectId: subject.id,
      totalRecords: file.records.length,
      created, updated, skipped, outcomesWritten,
    };
  }

  /**
   * Tìm-tạo đường tổ tiên (mạch → section → topic) của một bản ghi
   * trong cây của chương trình. Trả null khi bản ghi không mang bậc
   * cấu trúc nào — node lesson của nó nằm ở gốc cây.
   */
  private async ensureAncestors(index: TreeIndex, curriculumId: string, record: ProgramRecord): Promise<CurriculumNodeRow | null> {
    let parent: CurriculumNodeRow | null = null;
    for (const step of programRecordAncestors(record)) {
      const key = childKey(parent?.id ?? null, step.kind, step.title);
      const existing = index.childByKey.get(key);
      if (existing) {
        parent = existing;
        continue;
      }
      const position = this.takePosition(index, parent?.id ?? null);
      const node = await this.repo.insertNode({
        curriculumId, parentId: parent?.id ?? null, title: step.title, kind: step.kind, position,
      });
      index.childByKey.set(key, node);
      parent = node;
    }
    return parent;
  }

  /** Cấp position tiếp theo dưới một node cha trong lượt nạp (giữ thứ tự dataset). */
  private takePosition(index: TreeIndex, parentId: string | null): number {
    const key = parentId ?? '';
    const position = index.nextPosByParent.get(key) ?? 1;
    index.nextPosByParent.set(key, position + 1);
    return position;
  }
}
