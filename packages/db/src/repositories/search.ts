/**
 * Repository của cụm SEARCH trên Kysely — chuyển đổi Drizzle →
 * Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ liệu (issue
 * #648).
 *
 * Vai trò: mọi truy cập tới bảng search_documents của kho trung
 * tâm tập trung ở đây (ghi/gỡ tài liệu chỉ mục + engine truy vấn
 * tsvector). Repository không chứa luật nghiệp vụ — phân quyền lúc
 * truy vấn và registry area nằm ở tầng service phía ứng dụng.
 *
 * Hai điểm SQL thô giữ NGUYÊN VĂN như bản Drizzle (Recipes "Raw
 * SQL" của Kysely): `queryEngine` (biểu thức tsvector + bí danh
 * camelCase trong nháy kép đặt ngay trong văn bản SQL — bí danh là
 * một phần của văn bản SQL, không phải CamelCasePlugin, nên khoá
 * dòng kết quả giữ nguyên camelCase) và `matchesContent` (một biểu
 * thức boolean duy nhất, ba tham số). Phía Kysely `.execute()` trả
 * `QueryResult` trực tiếp nên các cast `as unknown as { rows }`
 * của bản Drizzle biến mất. Đếm tổng bằng `count(*)::int` trong
 * biểu thức `sql`: ép int4 ngay ở SQL nên giá trị về là số thật.
 */
import { sql, type Insertable, type Updateable } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type SearchDb = CentreDb | CentreTx;

/** Một dòng tài liệu trong chỉ mục tìm kiếm. */
export interface SearchDocRow {
  id: string;
  area: string;
  itemId: string;
  contextId: string;
  title: string;
  content: string;
  ownerId: string | null;
  updatedAt: Date;
}

/** Dữ kiện ghi một tài liệu chỉ mục mới. */
export interface NewSearchDoc {
  id?: string;
  area: string;
  itemId: string;
  contextId: string;
  title?: string;
  content?: string;
  ownerId?: string | null;
  updatedAt?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng search_documents. */
const SEARCH_DOC_COLUMNS = [
  'id',
  'area',
  'item_id as itemId',
  'context_id as contextId',
  'title',
  'content',
  'owner_id as ownerId',
  'updated_at as updatedAt',
] as const;

/** Ánh xạ dữ kiện ghi tài liệu từ camelCase sang snake_case, loại `undefined` từng trường. */
function searchDocInsertValues(values: NewSearchDoc): Insertable<CentreDB['search_documents']> {
  const row: Insertable<CentreDB['search_documents']> = {
    area: values.area,
    item_id: values.itemId,
    context_id: values.contextId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.title !== undefined) row.title = values.title;
  if (values.content !== undefined) row.content = values.content;
  if (values.ownerId !== undefined) row.owner_id = values.ownerId;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Kho tài liệu tìm kiếm Postgres: engine adapter thật dùng tsvector
 * (to_tsvector/plainto_tsquery) trên bảng search_documents.
 */
export class SearchRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle Kysely của kho trung tâm mà repository đang giữ (tầng service dùng cho các truy vấn đọc phụ trợ của module). */
  get dbHandle(): CentreDb {
    return this.handle;
  }

  /** Upsert một tài liệu theo (area, itemId). */
  async upsert(v: NewSearchDoc, db: SearchDb = this.handle): Promise<SearchDocRow> {
    // Nhánh cập nhật khi trùng (area, itemId): ownerId vắng mặt nghĩa
    // là gỡ chủ sở hữu (gán null tường minh như bản Drizzle), còn
    // title/content chỉ ghi khi dữ kiện có mang (luật T-4).
    const conflictSet: Updateable<CentreDB['search_documents']> = {
      context_id: v.contextId,
      owner_id: v.ownerId ?? null,
      updated_at: new Date(),
    };
    if (v.title !== undefined) conflictSet.title = v.title;
    if (v.content !== undefined) conflictSet.content = v.content;
    const rows = await db
      .insertInto('search_documents')
      .values(searchDocInsertValues(v))
      .onConflict((oc) => oc.columns(['area', 'item_id']).doUpdateSet(conflictSet))
      .returning(SEARCH_DOC_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Gỡ một tài liệu khỏi chỉ mục theo (area, itemId). */
  async remove(area: string, itemId: string, db: SearchDb = this.handle): Promise<void> {
    await db
      .deleteFrom('search_documents')
      .where('area', '=', area)
      .where('item_id', '=', itemId)
      .execute();
  }

  /** Gỡ mọi tài liệu của một chủ sở hữu khỏi chỉ mục. */
  async removeByOwner(ownerId: string, db: SearchDb = this.handle): Promise<void> {
    await db
      .deleteFrom('search_documents')
      .where('owner_id', '=', ownerId)
      .execute();
  }

  /** Lấy một tài liệu theo (area, itemId). */
  async get(area: string, itemId: string, db: SearchDb = this.handle): Promise<SearchDocRow | undefined> {
    return db
      .selectFrom('search_documents')
      .select(SEARCH_DOC_COLUMNS)
      .where('area', '=', area)
      .where('item_id', '=', itemId)
      .executeTakeFirst();
  }

  /** Liệt kê mọi tài liệu trong chỉ mục. */
  async listAll(db: SearchDb = this.handle): Promise<SearchDocRow[]> {
    return db.selectFrom('search_documents').select(SEARCH_DOC_COLUMNS).execute();
  }

  /** Tổng số tài liệu trong chỉ mục, đếm ở SQL — không nạp toàn bộ bảng về để lấy độ dài mảng. */
  async countAll(db: SearchDb = this.handle): Promise<number> {
    const row = await db
      .selectFrom('search_documents')
      .select(sql<number>`count(*)::int`.as('total'))
      .executeTakeFirst();
    return row?.total ?? 0;
  }

  /** Truy vấn engine Postgres: khớp tsvector, không lọc quyền ở đây — việc lọc là của service tại thời điểm truy vấn. */
  async queryEngine(q: string, db: SearchDb = this.handle): Promise<SearchDocRow[]> {
    if (!q.trim()) return [];
    const res = await sql<SearchDocRow>`select id, area, item_id as "itemId", title, content, context_id as "contextId", owner_id as "ownerId", updated_at as "updatedAt" from search_documents where to_tsvector('simple', title || ' ' || content) @@ plainto_tsquery('simple', ${q}) order by id`
      .execute(db);
    return res.rows;
  }

  /**
   * Kiểm tra một cặp (title, content) CHO TRƯỚC có khớp truy vấn hay
   * không, dùng đúng biểu thức tsvector của engine (`to_tsvector` trên
   * `title || ' ' || content` với `plainto_tsquery`, cùng cấu hình
   * 'simple'). Service dùng phép kiểm này để đối chiếu ứng viên với nội
   * dung công khai hiện hành của bản ghi gốc — không qua hàng đã lập chỉ
   * mục — nên kết luận khớp không phụ thuộc dữ liệu cũ còn sót trong
   * bảng `search_documents`.
   */
  async matchesContent(title: string, content: string, q: string, db: SearchDb = this.handle): Promise<boolean> {
    if (!q.trim()) return false;
    const res = await sql<{ matched: boolean }>`select (to_tsvector('simple', ${title} || ' ' || ${content}) @@ plainto_tsquery('simple', ${q})) as matched`
      .execute(db);
    return res.rows[0]?.matched === true;
  }
}
