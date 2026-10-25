import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProgramDatasetStatus, ProgramImportResult } from '@lms/contracts';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CurriculumRepository, type CurriculumNodeRow } from './curriculum.repository';
import { CURRICULUM_MANAGE, CURRICULUM_VIEW } from './curriculum.service';
import {
  loadProgramDataset, programAncestorNodeId, programCurriculumId, programDatasetByKey, programLessonNodeId,
  programRecordAncestors, programRecordEffectiveGrade, programRecordHash, programRecordOutcomeEntries,
  programRecordSourceRef, programRecordTitle, programSubjectId, PROGRAM_DATASETS,
  type ProgramDatasetDef, type ProgramDatasetFile, type ProgramRecord,
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
 * Cơ chế nạp dữ liệu chương trình chuẩn cấp hệ thống (K0a + GDPT-SEED):
 * chuyển các bản ghi đã kiểm chứng nguyên văn (dataset vendor trong
 * repo) vào cây chương trình ở context hệ thống.
 *
 * ĐỊNH DANH XÁC ĐỊNH (phương án D, issue #161, ADR-017): mọi dòng do
 * dataset sinh ra (môn, chương trình, node tổ tiên, node nội dung,
 * YCCĐ) được cấp id UUIDv5 theo khoá tự nhiên — xem program-datasets.ts.
 * Cùng một dataset → cùng một cây với cùng một tập id ở mọi môi trường.
 * Dòng đã tồn tại theo khoá tự nhiên với id khác (admin tạo tay, lượt
 * nạp kiểu cũ) thì HỘI TỤ giữ id hiện hữu, không ép đổi.
 *
 * LUẬT KHÔNG-XOÁ: đường nạp KHÔNG BAO GIỜ xoá node hay YCCĐ. Nhánh
 * cập nhật là một phép DIFF theo khoá tự nhiên: node giữ id kể cả khi
 * bản ghi đổi khối lớp (chuyển `curriculum_id` tại chỗ); YCCĐ nào
 * không còn trong dataset (Bộ rút, hoặc sửa chữ — sửa chữ = hash nội
 * dung đổi = YCCĐ mới) thì GIỮ NGUYÊN dòng trong DB và đếm vào
 * `orphanedOutcomes` của kết quả nạp để con người xử lý tường minh;
 * bản ghi biến mất khỏi dataset thì node của nó đếm vào
 * `orphanedNodes`. YCCĐ `source_kind='derived'` của tổ chuyên môn
 * không thuộc dataset — phép diff chỉ áp trên YCCĐ 'program', tuyệt
 * đối không đụng derived.
 *
 * Idempotent theo sổ đăng ký `curriculum_program_records`: khoá là
 * (dataset, mã bản ghi); hash nội dung khớp → bỏ qua, lệch → diff.
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
   * Nạp (hoặc nạp lại) một dataset theo khoá — đường API cho quản trị.
   * Cần curriculum:manage tại context hệ thống. Trả đếm tạo mới / cập
   * nhật / bỏ qua / orphaned để trang quản trị hiển thị và để đối
   * chiếu với tổng số bản ghi của dataset.
   */
  async importDataset(actorId: string, datasetKey: string): Promise<ProgramImportResult> {
    const def = this.defOr404(datasetKey);
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, sys.id);
    return this.runGuarded(def, sys.id, loadProgramDataset(def));
  }

  /**
   * Entry nội bộ cho seed (review-seed) và kiểm chứng: cùng một lõi
   * nạp như đường API nhưng KHÔNG qua PermissionEvaluator — chạy với
   * danh nghĩa hệ thống trong tiến trình seed, không phải một đường
   * nạp thứ hai.
   */
  async importDatasetInternal(datasetKey: string): Promise<ProgramImportResult> {
    const def = this.defOr404(datasetKey);
    const sys = await this.contexts.ensureSystemContext();
    return this.runGuarded(def, sys.id, loadProgramDataset(def));
  }

  /** Entry nội bộ như trên nhưng nạp từ một bản dataset đã đọc sẵn (kiểm chứng đính chính dùng bản sao đã sửa trong bộ nhớ). */
  async importDatasetFileInternal(datasetKey: string, file: ProgramDatasetFile): Promise<ProgramImportResult> {
    const def = this.defOr404(datasetKey);
    const sys = await this.contexts.ensureSystemContext();
    return this.runGuarded(def, sys.id, file);
  }

  /** Nạp lần lượt MỌI dataset trong manifest — đường seed dùng (idempotent: chạy lại là no-op theo sổ + hash). */
  async importAllDatasetsInternal(): Promise<ProgramImportResult[]> {
    const out: ProgramImportResult[] = [];
    for (const def of PROGRAM_DATASETS) out.push(await this.importDatasetInternal(def.key));
    return out;
  }

  private defOr404(datasetKey: string): ProgramDatasetDef {
    const def = programDatasetByKey(datasetKey);
    if (!def) {
      throw new NotFoundException({ message: `Program dataset ${datasetKey} is not in the manifest`, code: 'curriculum.program_dataset_not_found' });
    }
    return def;
  }

  /** Giữ khoá mutex theo dataset quanh một lượt nạp (mọi entry đều qua đây). */
  private async runGuarded(def: ProgramDatasetDef, systemContextId: string, file: ProgramDatasetFile): Promise<ProgramImportResult> {
    if (this.running.has(def.key)) {
      throw new ConflictException({ message: `Import of dataset ${def.key} is already running`, code: 'curriculum.program_import_in_progress' });
    }
    this.running.add(def.key);
    try {
      return await this.runImport(def, systemContextId, file);
    } finally {
      this.running.delete(def.key);
    }
  }

  private async runImport(def: ProgramDatasetDef, systemContextId: string, file: ProgramDatasetFile): Promise<ProgramImportResult> {
    if (file.records.length === 0) {
      throw new BadRequestException({ message: `Program dataset ${def.key} has no records`, code: 'curriculum.program_dataset_empty' });
    }
    // Môn đích ở context hệ thống: tìm theo slug (khoá tự nhiên), chưa
    // có thì tạo với id xác định; đã có với id khác thì hội tụ giữ id đó.
    let subject = await this.repo.getSubjectBySlug(def.slug);
    if (!subject) {
      subject = await this.repo.insertSubject({
        id: programSubjectId(def.slug),
        contextId: systemContextId,
        name: def.subjectName,
        slug: def.slug,
        position: PROGRAM_DATASETS.indexOf(def) + 1,
      });
    }
    // Chương trình theo khối: tìm theo cặp (môn, khối), chưa có thì
    // tạo với id xác định. Khối xét theo khối HIỆU LỰC của bản ghi
    // (bản ghi theo cấp grade=null neo vào khối đầu của cấp — xem
    // programRecordEffectiveGrade).
    const curricula = new Map<number, string>();
    for (const row of await this.repo.listCurricula(subject.id)) curricula.set(row.grade, row.id);
    for (const grade of new Set(file.records.map((r) => programRecordEffectiveGrade(file.records, r)))) {
      if (!curricula.has(grade)) {
        const created = await this.repo.insertCurriculum({ id: programCurriculumId(def.slug, grade), subjectId: subject.id, grade });
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
    let orphanedOutcomes = 0;
    for (const record of file.records) {
      const grade = programRecordEffectiveGrade(file.records, record);
      const curriculumId = curricula.get(grade)!;
      const index = await indexFor(curriculumId);
      const parent = await this.ensureAncestors(index, curriculumId, def.slug, grade, record);
      // Đường tổ tiên có thể rỗng (dataset không mang bậc cấu trúc nào,
      // ví dụ Âm nhạc): node lesson nằm ngay ở gốc cây của khối.
      const parentId = parent?.id ?? null;
      // Tựa node: nguyên văn content; bản ghi requirement content rỗng
      // thì suy xuống topic/section (xem programRecordTitle).
      const title = programRecordTitle(record);
      const hash = programRecordHash(record);
      const entries = programRecordOutcomeEntries(def.key, record);
      const reg = await this.repo.getProgramRecord(def.key, record.id);
      if (reg && reg.contentHash === hash) {
        // Đã khớp nguyên văn: không ghi gì, chỉ đếm các YCCĐ 'program'
        // hiện có mà dataset không còn chứa (orphaned của các lần
        // đính chính trước) để báo cáo luôn phản ánh hiện trạng.
        orphanedOutcomes += await this.countOrphanedOutcomes(reg.nodeId, entries);
        skipped += 1;
        continue;
      }
      const sourceRef = programRecordSourceRef(record);
      if (!reg) {
        const position = this.takePosition(index, parentId);
        const lessonId = programLessonNodeId(def.key, record.id);
        await this.repo.dbHandle.transaction(async (tx) => {
          const lesson = await this.repo.insertNode({
            id: lessonId, curriculumId, parentId, title, kind: 'lesson', position,
          }, tx as never);
          for (const entry of entries) {
            await this.repo.insertOutcome({
              id: entry.id, nodeId: lesson.id, content: entry.text, position: entry.position,
              sourceKind: 'program', sourceRef, derivedFromId: null,
            }, tx as never);
          }
          await this.repo.insertProgramRecord({
            datasetKey: def.key, recordId: record.id, subjectId: subject.id,
            curriculumId, nodeId: lesson.id, contentHash: hash, source: record.source,
          }, tx as never);
          index.childByKey.set(childKey(parentId, 'lesson', title), lesson);
        });
        created += 1;
        outcomesWritten += entries.length;
        continue;
      }
      // Bản ghi đã nạp nhưng dataset đã đính chính (hash lệch): DIFF
      // không-xoá. Node cập nhật TẠI CHỖ — đổi khối lớp là chuyển
      // curriculum_id của chính node đó (giữ id, giữ mọi tham chiếu);
      // YCCĐ diff theo id xác định neo nội dung (xem diffOutcomes).
      const current = await this.repo.getNode(reg.nodeId);
      const diff = await this.diffOutcomes(reg.nodeId, entries);
      orphanedOutcomes += diff.orphaned;
      await this.repo.dbHandle.transaction(async (tx) => {
        const patch: {
          title: string; parentId?: string | null; position?: number; curriculumId?: string;
        } = { title };
        if (reg.curriculumId !== curriculumId) patch.curriculumId = curriculumId;
        if (!current || current.parentId !== parentId || reg.curriculumId !== curriculumId) {
          patch.parentId = parentId;
          patch.position = this.takePosition(index, parentId);
        }
        await this.repo.updateNode(reg.nodeId, patch, tx as never);
        for (const write of diff.writes) {
          if (write.kind === 'insert') {
            await this.repo.insertOutcome({
              id: write.id, nodeId: reg.nodeId, content: write.text, position: write.position,
              sourceKind: 'program', sourceRef, derivedFromId: null,
            }, tx as never);
          } else {
            await this.repo.updateOutcome(write.id, { position: write.position }, tx as never);
          }
        }
        await this.repo.updateProgramRecord(reg.id, {
          subjectId: subject.id, curriculumId, nodeId: reg.nodeId, contentHash: hash, source: record.source,
        }, tx as never);
        if (current) index.childByKey.set(childKey(parentId, 'lesson', title), { ...current, ...patch });
      });
      updated += 1;
      outcomesWritten += diff.writes.length;
    }
    // Bản ghi đã biến mất khỏi dataset (Bộ rút khỏi chương trình):
    // node và YCCĐ của nó GIỮ NGUYÊN trong DB theo luật không-xoá,
    // chỉ đếm vào orphaned để quản trị xử lý tường minh.
    const fileIds = new Set(file.records.map((r) => r.id));
    let orphanedNodes = 0;
    for (const row of await this.repo.listProgramRecords(def.key)) {
      if (fileIds.has(row.recordId)) continue;
      orphanedNodes += 1;
      const outcomes = await this.repo.listOutcomes(row.nodeId);
      orphanedOutcomes += outcomes.filter((o) => o.sourceKind === 'program').length;
    }
    return {
      datasetKey: def.key,
      subjectId: subject.id,
      totalRecords: file.records.length,
      created, updated, skipped, outcomesWritten,
      orphanedNodes, orphanedOutcomes,
    };
  }

  /**
   * Đếm YCCĐ 'program' đang treo ở node mà tập dòng của dataset hiện
   * tại không còn chứa (theo id xác định): các dòng này là orphaned —
   * được giữ nguyên, không sửa, không xoá.
   */
  private async countOrphanedOutcomes(
    nodeId: string,
    entries: { id: string }[],
  ): Promise<number> {
    const desired = new Set(entries.map((e) => e.id));
    const existing = await this.repo.listOutcomes(nodeId);
    return existing.filter((o) => o.sourceKind === 'program' && !desired.has(o.id)).length;
  }

  /**
   * Diff YCCĐ 'program' của một node theo id xác định neo nội dung:
   * dòng còn trong dataset → giữ id + nội dung, chỉ cập nhật position
   * khi thứ tự đổi; dòng mới → insert với id xác định; dòng không còn
   * → orphaned (giữ nguyên, chỉ đếm). YCCĐ 'derived' không nằm trong
   * phép diff này và không bao giờ bị đụng.
   */
  private async diffOutcomes(
    nodeId: string,
    entries: { id: string; text: string; position: number }[],
  ): Promise<{
    writes: ({ kind: 'insert'; id: string; text: string; position: number } | { kind: 'reposition'; id: string; position: number })[];
    orphaned: number;
  }> {
    const existing = await this.repo.listOutcomes(nodeId);
    const programExisting = existing.filter((o) => o.sourceKind === 'program');
    const desired = new Set(entries.map((e) => e.id));
    const orphaned = programExisting.filter((o) => !desired.has(o.id)).length;
    const writes: ({ kind: 'insert'; id: string; text: string; position: number } | { kind: 'reposition'; id: string; position: number })[] = [];
    for (const entry of entries) {
      const found = programExisting.find((o) => o.id === entry.id);
      if (!found) {
        writes.push({ kind: 'insert', id: entry.id, text: entry.text, position: entry.position });
      } else if (found.position !== entry.position) {
        writes.push({ kind: 'reposition', id: entry.id, position: entry.position });
      }
    }
    return { writes, orphaned };
  }

  /**
   * Tìm-tạo đường tổ tiên (mạch → section → topic) của một bản ghi
   * trong cây của chương trình. Node tổ tiên chưa có được tạo với id
   * xác định theo đường tổ tiên đầy đủ; node đã có (kể cả do admin tạo
   * tay với id khác) thì hội tụ dùng lại. Trả null khi bản ghi không
   * mang bậc cấu trúc nào — node lesson của nó nằm ở gốc cây.
   */
  private async ensureAncestors(
    index: TreeIndex,
    curriculumId: string,
    slug: string,
    grade: number,
    record: ProgramRecord,
  ): Promise<CurriculumNodeRow | null> {
    let parent: CurriculumNodeRow | null = null;
    const path: [string, string][] = [];
    for (const step of programRecordAncestors(record)) {
      path.push([step.kind, step.title]);
      const key = childKey(parent?.id ?? null, step.kind, step.title);
      const existing = index.childByKey.get(key);
      if (existing) {
        parent = existing;
        continue;
      }
      const position = this.takePosition(index, parent?.id ?? null);
      const node = await this.repo.insertNode({
        id: programAncestorNodeId(slug, grade, path),
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
