import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProgramDatasetStatus, ProgramImportChange, ProgramImportResult } from '@lms/contracts';
import type { DbTx } from '../../db/database';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CurriculumRepository, type CurriculumNodeRow } from './curriculum.repository';
import { CURRICULUM_MANAGE, CURRICULUM_VIEW } from './curriculum.service';
import {
  loadProgramDataset, programAncestorNodeId, programCurriculumId, programDatasetByKey, programLessonNodeId,
  programOutcomeDocText, programRecordAncestors, programRecordEffectiveGrade, programRecordHash,
  programRecordOutcomeDocs, programRecordSourceRef, programRecordTitle, programSubjectId, PROGRAM_DATASETS,
  type ProgramOutcomeDoc,
  type ProgramDatasetDef, type ProgramDatasetFile, type ProgramRecord,
} from './program-datasets';

/** Trần số mục chi tiết trong báo cáo thay đổi của một lượt nạp một dataset (đếm tổng vẫn đầy đủ ở changeCounts). */
const IMPORT_CHANGES_CAP = 500;

/**
 * Một lệnh ghi YCCĐ mà thuật toán diff của một bản ghi sinh ra; toàn
 * bộ lệnh của một bản ghi được áp trong MỘT transaction (xem
 * applyOutcomeWrites cho thứ tự áp an toàn với partial unique index).
 * `update` gộp ba ca dùng chung hình dạng patch: moved (chỉ position),
 * text-changed (chỉ content), revived (retiredAt về null + position).
 */
type OutcomeWrite =
  // Chèn dòng mới KHÔNG mang id: DB cấp uuidv7 một lần (chốt 20:09
  // ngày 26/10/2026 — id YCCĐ là mờ, không tính từ thuộc tính nào).
  // `doc` là tài liệu Tiptap lưu trực tiếp vào cột jsonb; `text` là
  // text canonical trích từ chính tài liệu đó, chỉ dùng cho phép
  // ghép cặp của diff và báo cáo thay đổi, không phải dữ liệu lưu.
  | { kind: 'insert'; doc: ProgramOutcomeDoc; text: string; position: number }
  | { kind: 'update'; id: string; patch: { position?: number; content?: ProgramOutcomeDoc; retiredAt?: Date | null } }
  | { kind: 'retire'; id: string };

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
 * VAI TRÒ HIỆN HÀNH (chốt 20:09 ngày 26/10/2026, sổ mục E): service
 * này là CÔNG CỤ SẢN XUẤT DUMP Ở TRUNG TÂM — nạp/patch dataset vào
 * DB chuẩn để từ đó xuất dump đông cứng (xem program-dump.ts); seed
 * của các môi trường KHÔNG chạy importer nữa mà restore dump. Trang
 * quản trị đồng bộ chương trình cũng gọi qua service này.
 *
 * ĐỊNH DANH: môn/chương trình/node do dataset sinh ra được cấp id
 * UUIDv5 theo khoá tự nhiên (phương án D — xem program-datasets.ts);
 * riêng YCCĐ mang **uuidv7 mờ do DB cấp một lần** (BỎ HẲN UUIDv5
 * cho YCCĐ theo chốt 20:09): sửa chữ = sửa tại chỗ giữ id + liên
 * kết, thêm dòng = chèn dòng mới rồi set position. Tính khớp ID
 * giữa các môi trường đến từ dump literal, không từ công thức.
 *
 * LUẬT KHÔNG-XOÁ: đường nạp KHÔNG BAO GIỜ xoá node hay YCCĐ. Nhánh
 * cập nhật là một phép DIFF GHÉP CẶP THEO VỊ TRÍ + NỘI DUNG (đợt neo
 * lại định danh, issue #161, sổ mục E 19:57 ngày 26/10/2026 — xem
 * diffOutcomes): sửa chữ = sửa TẠI CHỖ giữ id và mọi liên kết; dòng
 * rời dataset thì chuyển sang trạng thái ĐÃ RÚT (cột `retired_at`,
 * dòng còn nguyên, đường đọc hiện hành tự loại); bản ghi biến mất
 * khỏi dataset thì node của nó đếm vào `orphanedNodes` và mọi dòng
 * hiện hành thuộc diện dataset quản của nó bị rút theo. Mọi thay đổi
 * theo từng dòng vào BÁO CÁO THAY ĐỔI của lần nạp cho người duyệt.
 * YCCĐ `source_kind='derived'` của tổ chuyên môn không thuộc dataset
 * — phép diff chỉ áp trên YCCĐ 'program' thuộc diện quản (source_ref
 * khác NULL), tuyệt đối không đụng derived.
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
    // Báo cáo thay đổi của lần nạp: tích luỹ theo từng dòng qua mọi
    // bản ghi (tạo mới, đính chính, rút cả bản ghi), chốt ở cuối lượt.
    const changes: ProgramImportChange[] = [];
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
      const entries = programRecordOutcomeDocs(record);
      const reg = await this.repo.getProgramRecord(def.key, record.id);
      if (reg && reg.contentHash === hash) {
        // Đã khớp nguyên văn theo hash — nhưng phải loại trừ ca bản
        // ghi vừa QUAY LẠI sau khi bị rút cả bản ghi: các dòng của nó
        // đang ở trạng thái đã rút trong khi nguyên văn của chúng
        // nằm trong dataset hiện tại; ca này phải rơi xuống nhánh
        // diff để P4 hồi sinh đúng các dòng đó. Trạng thái ổn định
        // (dòng đã rút vì bị bỏ khỏi dataset, nguyên văn không còn
        // trong bản ghi) thì giữ đường nhanh bỏ qua như cũ.
        const managed = await this.repo.listDatasetManagedOutcomes(reg.nodeId);
        const entryTexts = new Set(entries.map((e) => e.text));
        const revivable = managed.some((o) => o.retiredAt !== null && entryTexts.has(programOutcomeDocText(o.content)));
        if (!revivable) {
          skipped += 1;
          continue;
        }
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
              nodeId: lesson.id, content: entry.doc, position: entry.position,
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
        for (const entry of entries) {
          changes.push({ recordId: record.id, position: entry.position, kind: 'added', newText: entry.text });
        }
        continue;
      }
      // Bản ghi đã nạp nhưng dataset đã đính chính (hash lệch): DIFF
      // không-xoá. Node cập nhật TẠI CHỖ — đổi khối lớp là chuyển
      // curriculum_id của chính node đó (giữ id, giữ mọi tham chiếu);
      // YCCĐ diff ghép cặp theo vị trí + nội dung (xem diffOutcomes).
      const current = await this.repo.getNode(reg.nodeId);
      const diff = await this.diffOutcomes({ recordId: record.id, nodeId: reg.nodeId, entries });
      changes.push(...diff.changes);
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
        await this.applyOutcomeWrites(tx as never, reg.nodeId, sourceRef, diff.writes);
        await this.repo.updateProgramRecord(reg.id, {
          subjectId: subject.id, curriculumId, nodeId: reg.nodeId, contentHash: hash, source: record.source,
        }, tx as never);
        if (current) index.childByKey.set(childKey(parentId, 'lesson', title), { ...current, ...patch });
      });
      updated += 1;
      outcomesWritten += diff.writes.length;
    }
    // Bản ghi đã biến mất khỏi dataset (Bộ rút khỏi chương trình):
    // node GIỮ NGUYÊN trong DB theo luật không-xoá và đếm vào
    // orphanedNodes; mọi dòng hiện hành thuộc diện dataset quản của
    // node chuyển sang ĐÃ RÚT (P5 áp cho cả bản ghi) để pool và bản
    // đặc tả thôi đếm chúng, liên kết trỏ vào chúng còn nguyên và tra
    // theo id vẫn ra. Bản ghi quay lại ở lần nạp sau sẽ hồi sinh
    // từng dòng theo nguyên văn ở P4.
    const fileIds = new Set(file.records.map((r) => r.id));
    let orphanedNodes = 0;
    for (const row of await this.repo.listProgramRecords(def.key)) {
      if (fileIds.has(row.recordId)) continue;
      orphanedNodes += 1;
      const managed = await this.repo.listDatasetManagedOutcomes(row.nodeId);
      const currentManaged = managed.filter((o) => o.retiredAt === null);
      if (currentManaged.length === 0) continue;
      const links = await this.repo.countOutcomeLinks(currentManaged.map((o) => o.id));
      await this.repo.dbHandle.transaction(async (tx) => {
        for (const outcome of currentManaged) {
          await this.repo.updateOutcome(outcome.id, { retiredAt: new Date() }, tx as never);
        }
      });
      for (const outcome of currentManaged) {
        const link = links.get(outcome.id);
        changes.push({
          recordId: row.recordId, position: outcome.position, kind: 'removed', oldText: programOutcomeDocText(outcome.content),
          identicalTextAmbiguous: currentManaged.filter((o) => programOutcomeDocText(o.content) === programOutcomeDocText(outcome.content)).length >= 2 || undefined,
          linkedQuestions: link?.questions ?? 0, linkedBookMappings: link?.bookMappings ?? 0,
        });
        outcomesWritten += 1;
      }
    }
    // Chốt báo cáo thay đổi: sắp theo (bản ghi, vị trí), đếm đầy đủ
    // cả sáu đếm, danh sách chi tiết cắt ở trần đã chốt.
    const sortedChanges = [...changes].sort(
      (a, b) => a.recordId.localeCompare(b.recordId) || a.position - b.position,
    );
    const changeCounts = { textChanged: 0, added: 0, removed: 0, moved: 0, revived: 0, shiftSuspected: 0 };
    for (const change of changes) {
      if (change.kind === 'text-changed') changeCounts.textChanged += 1;
      else if (change.kind === 'added') changeCounts.added += 1;
      else if (change.kind === 'removed') changeCounts.removed += 1;
      else if (change.kind === 'moved') changeCounts.moved += 1;
      else changeCounts.revived += 1;
      if (change.shiftSuspected) changeCounts.shiftSuspected += 1;
    }
    return {
      datasetKey: def.key,
      subjectId: subject.id,
      totalRecords: file.records.length,
      created, updated, skipped, outcomesWritten,
      orphanedNodes,
      retiredOutcomes: await this.repo.countRetiredOutcomesForDataset(def.key),
      changeCounts,
      changes: sortedChanges.slice(0, IMPORT_CHANGES_CAP),
      changesOmitted: Math.max(0, sortedChanges.length - IMPORT_CHANGES_CAP),
    };
  }

  /**
   * Áp toàn bộ lệnh ghi YCCĐ của một bản ghi trong transaction của nó
   * theo thứ tự an toàn với partial unique index "một ô (node, vị
   * trí) hiện hành duy nhất":
   * - Pha A: mọi lệnh update có đổi vị trí được dời tạm tới dải vị
   *   trí cao riêng (≥ 1.000.000) — tránh hai dòng hoán đổi vị trí
   *   cho nhau va vào index giữa chừng.
   * - Pha B: các lệnh rút dòng chạy TRƯỚC khi dòng mới/dòng hồi sinh
   *   chiếm ô — ô của dòng vừa rút phải trống (ra khỏi index) trước.
   * - Pha C: áp patch cuối cho các lệnh update (vị trí đích, nội
   *   dung mới, hồi sinh).
   * - Pha D: chèn dòng mới.
   *
   * @param tx - Transaction Drizzle của bản ghi đang nạp.
   * @param nodeId - Node nội dung của bản ghi.
   * @param sourceRef - Truy vết nguồn ghi trên các dòng chèn mới.
   * @param writes - Các lệnh ghi do diffOutcomes sinh ra.
   */
  private async applyOutcomeWrites(tx: DbTx, nodeId: string, sourceRef: string, writes: OutcomeWrite[]): Promise<void> {
    const TEMP_POSITION_BASE = 1_000_000;
    let tempSeq = 0;
    for (const write of writes) {
      if (write.kind === 'update' && write.patch.position !== undefined) {
        tempSeq += 1;
        await this.repo.updateOutcome(write.id, { position: TEMP_POSITION_BASE + tempSeq }, tx);
      }
    }
    for (const write of writes) {
      if (write.kind === 'retire') {
        await this.repo.updateOutcome(write.id, { retiredAt: new Date() }, tx);
      }
    }
    for (const write of writes) {
      if (write.kind === 'update') {
        await this.repo.updateOutcome(write.id, write.patch, tx);
      }
    }
    for (const write of writes) {
      if (write.kind === 'insert') {
        await this.repo.insertOutcome({
          nodeId, content: write.doc, position: write.position,
          sourceKind: 'program', sourceRef, derivedFromId: null,
        }, tx);
      }
    }
  }

  /**
   * Diff YCCĐ thuộc diện dataset quản của một node: thuật toán GHÉP
   * CẶP 6 BƯỚC theo vị trí + nội dung (hồ sơ neo lại định danh, mục
   * Q3.3; sổ mục E 19:57 ngày 26/10/2026, mô hình ID theo chốt
   * 20:09 cùng ngày). Đầu vào: `entries` là các dòng mới của bản ghi
   * từ dataset (text canonical, vị trí 1-based — KHÔNG mang id: id
   * của dòng nằm ở phía DB, do DB cấp khi dòng được tạo); phía DB
   * tách hai tập — dòng HIỆN HÀNH và dòng ĐÃ RÚT — đều thuộc diện
   * quản (program + source_ref). Thứ tự các bước là bắt buộc, mỗi
   * bước chỉ xử lý phần còn lại của bước trước:
   * - P1 khớp (vị trí + nguyên văn): không đổi, không ghi.
   * - P2 khớp theo nguyên văn (bắt ca xô lệch thuần do chèn/bớt dòng
   *   ở chỗ khác): chỉ sửa cột `position`, giữ id — phép ghép theo
   *   nội dung là duy nhất nên ca này xác định hoàn toàn, không cờ.
   * - P3 khớp theo vị trí còn lại = SỬA CHỮ: cập nhật `content` tại
   *   chỗ, giữ id và mọi liên kết; gắn cờ `shiftSuspected` khi phép
   *   ghép có thể đã bắt nhầm dòng (văn mới trùng văn cũ của dòng
   *   khác, hoặc văn cũ xuất hiện ở vị trí khác trong dataset mới).
   * - P4 hồi sinh (nguyên văn của dòng đã rút quay lại — sống lại
   *   đúng dòng/id của nó) hoặc thêm mới (chèn dòng mới, DB cấp id
   *   uuidv7 mới — không tính id từ bất kỳ thuộc tính nào).
   * - P5 rút dòng còn thừa: đặt `retired_at`, KHÔNG xoá dòng hay
   *   liên kết; gắn `identicalTextAmbiguous` khi dòng nằm trong nhóm
   *   trùng hệt nhau (không phân định được bằng văn bản).
   * - P6 là chính việc gắn cờ ở P3 (không thao tác dữ liệu riêng).
   * Số liên kết (câu hỏi + ánh xạ sách) được đếm tại thời điểm nạp
   * cho các ca text-changed và removed. YCCĐ 'derived' và dòng
   * program ngoài diện quản không nằm trong phép diff này.
   */
  private async diffOutcomes(input: {
    recordId: string; nodeId: string;
    entries: { doc: ProgramOutcomeDoc; text: string; position: number }[];
  }): Promise<{ writes: OutcomeWrite[]; changes: ProgramImportChange[] }> {
    const { recordId, entries } = input;
    const managed = await this.repo.listDatasetManagedOutcomes(input.nodeId);
    const current = managed.filter((o) => o.retiredAt === null);
    const retiredPool = managed.filter((o) => o.retiredAt !== null);
    const writes: OutcomeWrite[] = [];
    const changes: ProgramImportChange[] = [];
    const takenEntries = new Set<number>();
    const takenRows = new Set<string>();
    // Các ca cần đếm liên kết khi chốt diff: (dòng, mục thay đổi của nó).
    const linkTargets: { outcomeId: string; change: ProgramImportChange }[] = [];

    // P1 — khớp (vị trí + nguyên văn): dòng không đổi, không ghi gì.
    entries.forEach((entry, idx) => {
      const row = current.find(
        (o) => !takenRows.has(o.id) && o.position === entry.position && programOutcomeDocText(o.content) === entry.text,
      );
      if (row) {
        takenEntries.add(idx);
        takenRows.add(row.id);
      }
    });

    // P2 — khớp theo nguyên văn cho phần còn lại (ca xô lệch thuần):
    // nhóm trùng ghép theo thứ tự vị trí tăng dần ở cả hai phía.
    const groupByText = <T extends { text: string }>(items: T[]): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const item of items) map.set(item.text, [...(map.get(item.text) ?? []), item]);
      return map;
    };
    const remainingEntries = entries
      .map((entry, idx) => ({ ...entry, idx }))
      .filter((e) => !takenEntries.has(e.idx));
    const remainingCurrent = current.filter((o) => !takenRows.has(o.id));
    const entryGroups = groupByText(remainingEntries);
    const rowGroups = new Map<string, typeof remainingCurrent>();
    for (const row of remainingCurrent) {
      const text = programOutcomeDocText(row.content);
      rowGroups.set(text, [...(rowGroups.get(text) ?? []), row]);
    }
    for (const [text, group] of entryGroups) {
      const rows = rowGroups.get(text);
      if (!rows) continue;
      const sortedEntries = [...group].sort((a, b) => a.position - b.position);
      const sortedRows = [...rows].sort((a, b) => a.position - b.position);
      const pairs = Math.min(sortedEntries.length, sortedRows.length);
      for (let i = 0; i < pairs; i += 1) {
        const entry = sortedEntries[i]!;
        const row = sortedRows[i]!;
        takenEntries.add(entry.idx);
        takenRows.add(row.id);
        // Vị trí khác nhau là chắc chắn (bằng nhau + cùng văn thì P1
        // đã ghép) — chỉ sửa cột position, giữ id và mọi liên kết.
        writes.push({ kind: 'update', id: row.id, patch: { position: entry.position } });
        changes.push({ recordId, position: entry.position, kind: 'moved', newText: entry.text });
      }
    }

    // P3 — khớp theo vị trí còn lại = sửa chữ tại chỗ.
    entries.forEach((entry, idx) => {
      if (takenEntries.has(idx)) return;
      const row = current.find((o) => !takenRows.has(o.id) && o.position === entry.position);
      if (!row) return;
      takenEntries.add(idx);
      takenRows.add(row.id);
      writes.push({ kind: 'update', id: row.id, patch: { content: entry.doc } });
      // P6 — gắn cờ nghi lệch: văn mới trùng văn cũ của một dòng
      // current KHÁC, hoặc văn cũ của dòng này xuất hiện ở một vị trí
      // khác trong dataset mới (dòng mang văn đó đã không được P2
      // ghép về chính dòng này — nó còn đứng ở đây chính là bằng chứng).
      const rowText = programOutcomeDocText(row.content);
      const shiftSuspected =
        current.some((o) => o.id !== row.id && programOutcomeDocText(o.content) === entry.text) ||
        entries.some((e) => e.text === rowText && e.position !== entry.position);
      const change: ProgramImportChange = {
        recordId, position: entry.position, kind: 'text-changed',
        oldText: rowText, newText: entry.text,
        shiftSuspected: shiftSuspected || undefined,
      };
      changes.push(change);
      linkTargets.push({ outcomeId: row.id, change });
    });

    // P4 — hồi sinh hoặc thêm mới cho các entry còn lại.
    const revivedRowIds = new Set<string>();
    for (const [idx, entry] of entries.entries()) {
      if (takenEntries.has(idx)) continue;
      takenEntries.add(idx);
      const revived = retiredPool.find((o) => !revivedRowIds.has(o.id) && programOutcomeDocText(o.content) === entry.text);
      if (revived) {
        revivedRowIds.add(revived.id);
        writes.push({ kind: 'update', id: revived.id, patch: { position: entry.position, retiredAt: null } });
        changes.push({ recordId, position: entry.position, kind: 'revived', newText: entry.text });
        continue;
      }
      // Thêm mới: chèn dòng mới, DB cấp id uuidv7 mờ một lần —
      // không tính id từ vị trí/nội dung/khoá nào (chốt 20:09).
      writes.push({ kind: 'insert', doc: entry.doc, text: entry.text, position: entry.position });
      changes.push({ recordId, position: entry.position, kind: 'added', newText: entry.text });
    }

    // P5 — rút các dòng current không được ghép: giữ dòng + liên kết,
    // chỉ đặt trạng thái rút. Nhóm dòng trùng hệt nhau không phân
    // định được bằng văn bản → gắn cờ để người duyệt quyết.
    for (const row of current) {
      if (takenRows.has(row.id)) continue;
      writes.push({ kind: 'retire', id: row.id });
      const rowText = programOutcomeDocText(row.content);
      const change: ProgramImportChange = {
        recordId, position: row.position, kind: 'removed', oldText: rowText,
        identicalTextAmbiguous: current.filter((o) => programOutcomeDocText(o.content) === rowText).length >= 2 || undefined,
      };
      changes.push(change);
      linkTargets.push({ outcomeId: row.id, change });
    }

    // Đếm liên kết tại thời điểm nạp cho các ca sửa chữ + rút dòng.
    if (linkTargets.length > 0) {
      const links = await this.repo.countOutcomeLinks(linkTargets.map((t) => t.outcomeId));
      for (const target of linkTargets) {
        const link = links.get(target.outcomeId);
        target.change.linkedQuestions = link?.questions ?? 0;
        target.change.linkedBookMappings = link?.bookMappings ?? 0;
      }
    }
    return { writes, changes };
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
