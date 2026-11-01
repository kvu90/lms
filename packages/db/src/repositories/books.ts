/**
 * Repository của cụm SÁCH GIÁO KHOA trên Kysely — hạng mục nhân
 * rộng G7 của chiến dịch chuyển tầng dữ liệu (issue #647), chuyển
 * từ repository Drizzle cũ ở
 * `apps/api/src/modules/books/books.repository.ts`.
 *
 * Vai trò: mọi truy cập tới bốn bảng của kho trung tâm thuộc tầng
 * SGK — `books` (cuốn sách), `book_nodes` (cây chủ đề → bài),
 * `book_mappings` (ánh xạ bài sang node chương trình hoặc YCCĐ) và
 * `book_records` (sổ đăng ký nạp dataset, khoá idempotent của
 * lượt nạp) — tập trung ở đây, kèm một hình chiếu đọc truy nguồn
 * trên bảng `question` (cặp truy vết nguồn sách). Luật nạp dataset
 * (phân giải ánh xạ trước khi ghi, idempotent theo sổ) nằm ở tầng
 * service phía ứng dụng; repository chỉ nhận handle để service
 * ghép các thao tác ghi của một bản ghi vào một transaction.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package): bên trong dùng tên cột
 * snake_case của interface schema codegen; bên ngoài trả/nhận hình
 * dạng camelCase qua danh sách cột tường minh có bí danh và các
 * hàm ánh xạ ghi loại `undefined` từng trường (thử nghiệm T-4);
 * mọi giá trị where là tham số bắt buộc. Điều kiện lọc động của
 * `listBooks` (môn/kind tuỳ chọn) được xâu chuỗi bằng các mệnh đề
 * `.where` nối tiếp — khuôn T-13 đã chốt ở hạng mục nền, không
 * chép dạng `where(undefined)` của Drizzle. Cột jsonb
 * `book_records.source` không mang hình dạng `$type` ở phía
 * Drizzle cũ nên kiểu công khai ở biên là `unknown` như trước, và
 * mọi lần ghi đều đi qua helper serialize `::jsonb` duy nhất trong
 * file này.
 *
 * Hai hành vi giữ nguyên có chủ đích từ đường Drizzle cũ:
 * - `listBooks` sắp xếp ở tầng ứng dụng (khối lớp, rồi position,
 *   rồi thời gian tạo) sau khi đọc, không đẩy `ORDER BY` xuống
 *   truy vấn.
 * - Thứ tự hiển thị của cây sách luôn là position tăng dần rồi
 *   thời gian tạo — cùng quy ước của CurriculumRepository.
 *
 * Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 * dụng, không tự mở pool, không đọc biến môi trường.
 */
import { sql, type Insertable, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
type RepoDb = CentreDb | CentreTx;

/** Một dòng cuốn sách. */
export interface BookRow {
  id: string;
  kind: string;
  title: string;
  subjectId: string | null;
  grade: number | null;
  series: string | null;
  author: string | null;
  publisher: string | null;
  publishedYear: number | null;
  isbn: string | null;
  /** true khi trang hiển thị được phép ghi nguồn sách công khai. */
  attributionPublic: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một cuốn sách mới. */
export interface NewBook {
  id?: string;
  kind?: string;
  title: string;
  subjectId?: string | null;
  grade?: number | null;
  series?: string | null;
  author?: string | null;
  publisher?: string | null;
  publishedYear?: number | null;
  isbn?: string | null;
  attributionPublic?: boolean;
  position?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng node trong cây sách: chủ đề (`chapter`) hoặc bài (`lesson`). */
export interface BookNodeRow {
  id: string;
  bookId: string;
  parentId: string | null;
  title: string;
  kind: string;
  volume: number | null;
  lessonNumber: number | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một node sách mới. */
export interface NewBookNode {
  id?: string;
  bookId: string;
  parentId?: string | null;
  title: string;
  kind?: string;
  volume?: number | null;
  lessonNumber?: number | null;
  position?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng ánh xạ bài SGK → node chương trình hoặc → YCCĐ (đúng một trong hai đích có giá trị). */
export interface BookMappingRow {
  id: string;
  bookNodeId: string;
  curriculumNodeId: string | null;
  learningOutcomeId: string | null;
  position: number;
  createdAt: Date;
}

/** Dữ kiện ghi một dòng ánh xạ mới. */
export interface NewBookMapping {
  id?: string;
  bookNodeId: string;
  curriculumNodeId?: string | null;
  learningOutcomeId?: string | null;
  position: number;
  createdAt?: Date;
}

/**
 * Một dòng sổ đăng ký nạp: cặp (dataset, mã bản ghi) đã được nạp
 * vào node nào, kèm hash nội dung để lượt nạp sau nhận biết bản
 * ghi không đổi và `source` là bản ghi nguồn nguyên văn (jsonb).
 */
export interface BookRecordRow {
  id: string;
  datasetKey: string;
  recordId: string;
  bookId: string;
  nodeId: string;
  contentHash: string;
  source: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một dòng sổ đăng ký mới. */
export interface NewBookRecord {
  id?: string;
  datasetKey: string;
  recordId: string;
  bookId: string;
  nodeId: string;
  contentHash: string;
  source: unknown;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Hình chiếu truy nguồn sách → câu: chỉ định danh và siêu dữ liệu soạn thảo, không có nội dung câu. */
export interface BookSourceQuestionRow {
  id: string;
  qtype: string;
  category: string;
  createdBy: string | null;
  copyCount: number;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng sách. */
const BOOK_COLUMNS = [
  'id',
  'kind',
  'title',
  'subject_id as subjectId',
  'grade',
  'series',
  'author',
  'publisher',
  'published_year as publishedYear',
  'isbn',
  'attribution_public as attributionPublic',
  'position',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng node sách. */
const BOOK_NODE_COLUMNS = [
  'id',
  'book_id as bookId',
  'parent_id as parentId',
  'title',
  'kind',
  'volume',
  'lesson_number as lessonNumber',
  'position',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng ánh xạ sách. */
const BOOK_MAPPING_COLUMNS = [
  'id',
  'book_node_id as bookNodeId',
  'curriculum_node_id as curriculumNodeId',
  'learning_outcome_id as learningOutcomeId',
  'position',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng sổ đăng ký nạp. */
const BOOK_RECORD_COLUMNS = [
  'id',
  'dataset_key as datasetKey',
  'record_id as recordId',
  'book_id as bookId',
  'node_id as nodeId',
  'content_hash as contentHash',
  'source',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh —
 * helper serialize duy nhất của file này cho mọi lần ghi jsonb
 * (khuôn của pilot: driver `pg` tự stringify object thường nhưng
 * hiểu MẢNG cấp cao nhất là mảng PostgreSQL, khiến cột jsonb lỗi
 * `invalid input syntax for type json`). Cột `source` không mang
 * hình dạng `$type` ở phía Drizzle cũ nên giá trị ở biên là
 * `unknown` — helper ghim kiểu biểu thức về `JsonValue` của
 * codegen để khớp kiểu cột khi biên dịch, thay vì suy kiểu từ
 * giá trị như khuôn generic của pilot.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Ánh xạ dữ kiện ghi sách (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function bookInsertValues(values: NewBook): Insertable<CentreDB['books']> {
  const row: Insertable<CentreDB['books']> = { title: values.title };
  if (values.id !== undefined) row.id = values.id;
  if (values.kind !== undefined) row.kind = values.kind;
  if (values.subjectId !== undefined) row.subject_id = values.subjectId;
  if (values.grade !== undefined) row.grade = values.grade;
  if (values.series !== undefined) row.series = values.series;
  if (values.author !== undefined) row.author = values.author;
  if (values.publisher !== undefined) row.publisher = values.publisher;
  if (values.publishedYear !== undefined) row.published_year = values.publishedYear;
  if (values.isbn !== undefined) row.isbn = values.isbn;
  if (values.attributionPublic !== undefined) row.attribution_public = values.attributionPublic;
  if (values.position !== undefined) row.position = values.position;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ dữ kiện ghi node sách (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function bookNodeInsertValues(values: NewBookNode): Insertable<CentreDB['book_nodes']> {
  const row: Insertable<CentreDB['book_nodes']> = { book_id: values.bookId, title: values.title };
  if (values.id !== undefined) row.id = values.id;
  if (values.parentId !== undefined) row.parent_id = values.parentId;
  if (values.kind !== undefined) row.kind = values.kind;
  if (values.volume !== undefined) row.volume = values.volume;
  if (values.lessonNumber !== undefined) row.lesson_number = values.lessonNumber;
  if (values.position !== undefined) row.position = values.position;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch sửa node sách (camelCase) sang set update
 * (snake_case), LOẠI mọi trường `undefined` — patch chỉ chứa
 * trường nào thì chỉ trường đó đổi (quy tắc T-4).
 */
function bookNodeUpdateSet(patch: Partial<NewBookNode>): UpdateObject<CentreDB, 'book_nodes'> {
  const set: UpdateObject<CentreDB, 'book_nodes'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.bookId !== undefined) set.book_id = patch.bookId;
  if (patch.parentId !== undefined) set.parent_id = patch.parentId;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.volume !== undefined) set.volume = patch.volume;
  if (patch.lessonNumber !== undefined) set.lesson_number = patch.lessonNumber;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/** Ánh xạ dữ kiện ghi ánh xạ (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function bookMappingInsertValues(values: NewBookMapping): Insertable<CentreDB['book_mappings']> {
  const row: Insertable<CentreDB['book_mappings']> = {
    book_node_id: values.bookNodeId,
    position: values.position,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.curriculumNodeId !== undefined) row.curriculum_node_id = values.curriculumNodeId;
  if (values.learningOutcomeId !== undefined) row.learning_outcome_id = values.learningOutcomeId;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/**
 * Ánh xạ dữ kiện ghi dòng sổ (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường `undefined` (T-4); cột `source`
 * jsonb đi qua helper serialize. Biến tích luỹ khai kiểu
 * `InsertObject` vì values chứa trường biểu thức (theo sổ tay).
 */
function bookRecordInsertValues(values: NewBookRecord): InsertObject<CentreDB, 'book_records'> {
  const row: InsertObject<CentreDB, 'book_records'> = {
    dataset_key: values.datasetKey,
    record_id: values.recordId,
    book_id: values.bookId,
    node_id: values.nodeId,
    content_hash: values.contentHash,
    source: jsonbValue(values.source),
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch sửa dòng sổ (camelCase) sang set update
 * (snake_case), LOẠI mọi trường `undefined` (T-4); cột `source`
 * jsonb đi qua helper serialize.
 */
function bookRecordUpdateSet(patch: Partial<NewBookRecord>): UpdateObject<CentreDB, 'book_records'> {
  const set: UpdateObject<CentreDB, 'book_records'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.datasetKey !== undefined) set.dataset_key = patch.datasetKey;
  if (patch.recordId !== undefined) set.record_id = patch.recordId;
  if (patch.bookId !== undefined) set.book_id = patch.bookId;
  if (patch.nodeId !== undefined) set.node_id = patch.nodeId;
  if (patch.contentHash !== undefined) set.content_hash = patch.contentHash;
  if (patch.source !== undefined) set.source = jsonbValue(patch.source);
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/**
 * Repository tầng SGK trên Kysely: sách → cây node → ánh xạ sang
 * chương trình → sổ đăng ký nạp, trên kho trung tâm.
 */
export class BookRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm qua handle của repository. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  // --- sách ----------------------------------------------------------------------

  /** Chèn cuốn sách. */
  async insertBook(values: NewBook, db: RepoDb = this.db()): Promise<BookRow> {
    const rows = await db.insertInto('books').values(bookInsertValues(values)).returning(BOOK_COLUMNS).execute();
    return rows[0]!;
  }

  /** Lấy cuốn sách theo id. */
  async getBook(id: string, db: RepoDb = this.db()): Promise<BookRow | undefined> {
    return db.selectFrom('books').select(BOOK_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Tìm cuốn sách theo định danh tự nhiên (môn, khối, tựa) — khoá tìm-tạo của lượt nạp. */
  async findBook(subjectId: string, grade: number, title: string, db: RepoDb = this.db()): Promise<BookRow | undefined> {
    return db
      .selectFrom('books')
      .select(BOOK_COLUMNS)
      .where('subject_id', '=', subjectId)
      .where('grade', '=', grade)
      .where('title', '=', title)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Liệt kê sách, tuỳ chọn lọc theo môn và loại. Điều kiện lọc
   * động được xâu chuỗi bằng `.where` nối tiếp (khuôn T-13); thứ
   * tự cuối cùng sắp ở tầng ứng dụng: khối lớp tăng dần, rồi
   * position, rồi thời gian tạo — như đường Drizzle cũ.
   */
  async listBooks(subjectId?: string, kind?: string, db: RepoDb = this.db()): Promise<BookRow[]> {
    let query = db.selectFrom('books').select(BOOK_COLUMNS);
    if (subjectId) query = query.where('subject_id', '=', subjectId);
    if (kind) query = query.where('kind', '=', kind);
    const rows = await query.execute();
    return rows.sort(
      (a, b) => (a.grade ?? 0) - (b.grade ?? 0) || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  // --- cây sách --------------------------------------------------------------------

  /** Chèn node sách (chủ đề hoặc bài). */
  async insertBookNode(values: NewBookNode, db: RepoDb = this.db()): Promise<BookNodeRow> {
    const rows = await db
      .insertInto('book_nodes')
      .values(bookNodeInsertValues(values))
      .returning(BOOK_NODE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy node sách theo id. */
  async getBookNode(id: string, db: RepoDb = this.db()): Promise<BookNodeRow | undefined> {
    return db.selectFrom('book_nodes').select(BOOK_NODE_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Toàn bộ node của một cuốn sách theo thứ tự cây (position, rồi thời gian tạo). */
  async listBookNodes(bookId: string, db: RepoDb = this.db()): Promise<BookNodeRow[]> {
    return db
      .selectFrom('book_nodes')
      .select(BOOK_NODE_COLUMNS)
      .where('book_id', '=', bookId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Sửa node sách (đã lọc trường ở tầng service); mốc `updated_at` luôn được làm mới ở đây. */
  async updateBookNode(id: string, values: Partial<NewBookNode>, db: RepoDb = this.db()): Promise<void> {
    await db
      .updateTable('book_nodes')
      .set({ ...bookNodeUpdateSet(values), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  // --- ánh xạ ----------------------------------------------------------------------

  /** Chèn một dòng ánh xạ bài → node chương trình hoặc → YCCĐ. */
  async insertMapping(values: NewBookMapping, db: RepoDb = this.db()): Promise<BookMappingRow> {
    const rows = await db
      .insertInto('book_mappings')
      .values(bookMappingInsertValues(values))
      .returning(BOOK_MAPPING_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Mọi dòng ánh xạ của một node bài, theo position rồi thời gian tạo. */
  async listMappingsForNode(bookNodeId: string, db: RepoDb = this.db()): Promise<BookMappingRow[]> {
    return db
      .selectFrom('book_mappings')
      .select(BOOK_MAPPING_COLUMNS)
      .where('book_node_id', '=', bookNodeId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Mọi dòng ánh xạ của nhiều node bài (cho cây sách/đơn vị khung); danh sách rỗng trả rỗng ngay, không truy vấn. */
  async listMappingsForNodes(bookNodeIds: string[], db: RepoDb = this.db()): Promise<BookMappingRow[]> {
    if (bookNodeIds.length === 0) return [];
    return db
      .selectFrom('book_mappings')
      .select(BOOK_MAPPING_COLUMNS)
      .where('book_node_id', 'in', bookNodeIds)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  /** Xoá toàn bộ ánh xạ của một node bài (thay mới khi dataset đính chính). */
  async deleteMappingsForNode(bookNodeId: string, db: RepoDb = this.db()): Promise<void> {
    await db.deleteFrom('book_mappings').where('book_node_id', '=', bookNodeId).execute();
  }

  // --- sổ đăng ký nạp ----------------------------------------------------------------

  /** Tra sổ đăng ký theo cặp (dataset, mã bản ghi) — khoá idempotent của lượt nạp. */
  async getBookRecord(datasetKey: string, recordId: string, db: RepoDb = this.db()): Promise<BookRecordRow | undefined> {
    return db
      .selectFrom('book_records')
      .select(BOOK_RECORD_COLUMNS)
      .where('dataset_key', '=', datasetKey)
      .where('record_id', '=', recordId)
      .limit(1)
      .executeTakeFirst();
  }

  /** Mọi dòng sổ của một dataset. */
  async listBookRecords(datasetKey: string, db: RepoDb = this.db()): Promise<BookRecordRow[]> {
    return db.selectFrom('book_records').select(BOOK_RECORD_COLUMNS).where('dataset_key', '=', datasetKey).execute();
  }

  /** Mọi dòng sổ trỏ vào một cuốn sách (mọi dataset) — dựng mã bản ghi cho cây sách. */
  async listBookRecordsByBook(bookId: string, db: RepoDb = this.db()): Promise<BookRecordRow[]> {
    return db.selectFrom('book_records').select(BOOK_RECORD_COLUMNS).where('book_id', '=', bookId).execute();
  }

  /** Ghi dòng sổ cho một bản ghi vừa nạp. */
  async insertBookRecord(values: NewBookRecord, db: RepoDb = this.db()): Promise<BookRecordRow> {
    const rows = await db
      .insertInto('book_records')
      .values(bookRecordInsertValues(values))
      .returning(BOOK_RECORD_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Cập nhật dòng sổ khi dataset đính chính; mốc `updated_at` luôn được làm mới ở đây. */
  async updateBookRecord(id: string, values: Partial<NewBookRecord>, db: RepoDb = this.db()): Promise<void> {
    await db
      .updateTable('book_records')
      .set({ ...bookRecordUpdateSet(values), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Các câu hỏi có nguồn gốc từ cuốn sách này (truy nguồn chiều
   * sách → câu): quan hệ qua cặp truy vết (source_kind='book',
   * source_ref = id sách dạng chữ) trên bảng question — không FK
   * cứng theo thiết kế nguồn ngoài hệ thống. Chỉ trả định danh và
   * siêu dữ liệu soạn thảo, không trả nội dung câu.
   */
  async listQuestionsByBookSource(bookId: string, db: RepoDb = this.db()): Promise<BookSourceQuestionRow[]> {
    return db
      .selectFrom('question')
      .select(['id', 'qtype', 'category', 'created_by as createdBy', 'copy_count as copyCount'])
      .where('source_kind', '=', 'book')
      .where('source_ref', '=', bookId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }
}
