/**
 * Repository của cụm XÃ HỘI trên Kysely — hạng mục nhân rộng G7
 * của chiến dịch chuyển tầng dữ liệu (issue #647), chuyển từ
 * repository Drizzle cũ ở
 * `apps/api/src/modules/social/social.repository.ts`.
 *
 * Vai trò: mọi truy cập tới bảy bảng của kho trung tâm thuộc
 * module xã hội — `tag_collection`, `tag`, `tag_instance`,
 * `tag_correlation` (hệ thống thẻ), `comments` (bình luận),
 * `rating` (đánh giá) và `notes` (ghi chú khoá học) — tập trung ở
 * đây. Các bảng này đa hình theo bộ (component, item/area, itemId,
 * contextId) không có FK cứng; luật gác quyền và kiểm tra quyền
 * xem/ghi nằm ở các service con phía ứng dụng (tags / comments /
 * ratings / notes), repository chỉ thực thi truy cập dữ kiện.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package): bên trong dùng tên cột
 * snake_case của interface schema codegen; bên ngoài trả/nhận hình
 * dạng camelCase qua danh sách cột tường minh có bí danh và các
 * hàm ánh xạ ghi loại `undefined` từng trường (thử nghiệm T-4);
 * mọi giá trị where là tham số bắt buộc. Repository không import
 * từ `apps/*`, không đọc ALS/ngữ cảnh ứng dụng, không tự mở pool,
 * không đọc biến môi trường.
 *
 * Lưu ý giao dịch: không service nào của cụm này mở giao dịch qua
 * repository (kiểm kê ở thân PR của issue #647) — phương thức
 * `transaction` vẫn có mặt theo khuôn chung để phía gọi tương lai
 * ghép thao tác khi cần, và mọi phương thức nhận handle tuỳ chọn
 * làm tham số cuối như các repository đã chuyển đổi khác.
 */
import type { Insertable } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
type RepoDb = CentreDb | CentreTx;

/** Một dòng bộ sưu tập thẻ. */
export interface TagCollectionRow {
  id: string;
  name: string;
  /** true với bộ sưu tập chuẩn của hệ (bộ mặc định được gieo sẵn). */
  isStandard: boolean;
  component: string | null;
  searchable: boolean;
  customUrl: string | null;
}

/** Một dòng thẻ: `name` là dạng đã chuẩn hoá (viết thường), `rawName` giữ dạng hiển thị. */
export interface TagRow {
  id: string;
  userId: string | null;
  tagCollId: string | null;
  name: string;
  rawName: string;
  isStandard: boolean;
  flag: number;
  updatedAt: Date;
}

/** Dữ kiện ghi một thẻ mới (chính thức hoặc cá nhân). */
export interface NewTag {
  id?: string;
  userId?: string | null;
  tagCollId?: string | null;
  name: string;
  rawName: string;
  isStandard?: boolean;
  flag?: number;
  updatedAt?: Date;
}

/** Một dòng gắn thẻ vào một item (liên kết đa hình, không FK tới item). */
export interface TagInstanceRow {
  id: string;
  tagId: string;
  component: string;
  itemType: string;
  itemId: string;
  contextId: string;
  /** User mà việc gắn thẻ thuộc về (đường cá nhân); null với gắn thẻ dùng chung. */
  tiUserId: string | null;
  ordering: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một lần gắn thẻ vào item. */
export interface NewTagInstance {
  id?: string;
  tagId: string;
  component: string;
  itemType: string;
  itemId: string;
  contextId: string;
  tiUserId?: string | null;
  ordering?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Một dòng tương quan thẻ: danh sách id thẻ cùng xuất hiện, cách nhau bằng dấu phẩy. */
export interface TagCorrelationRow {
  tagId: string;
  correlatedTags: string;
}

/** Một dòng bình luận trên một item. */
export interface CommentRow {
  id: string;
  contextId: string;
  component: string;
  commentArea: string;
  itemId: string;
  content: string;
  format: number;
  userId: string;
  createdAt: Date;
  /** Mốc xoá mềm; null khi bình luận còn hiệu lực. */
  timeDeleted: Date | null;
}

/** Dữ kiện ghi một bình luận mới. */
export interface NewComment {
  id?: string;
  contextId: string;
  component: string;
  commentArea: string;
  itemId: string;
  content: string;
  format?: number;
  userId: string;
  createdAt?: Date;
  timeDeleted?: Date | null;
}

/** Một dòng đánh giá của một user cho một item. */
export interface RatingRow {
  id: string;
  contextId: string;
  component: string;
  ratingArea: string;
  itemId: string;
  scaleId: number;
  rating: number;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi/cập nhật một đánh giá (khoá tự nhiên là bộ năm cột của chỉ số duy nhất `rating_unique`). */
export interface NewRating {
  id?: string;
  contextId: string;
  component: string;
  ratingArea: string;
  itemId: string;
  scaleId: number;
  rating: number;
  userId: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Một dòng ghi chú về một user. `publishState` quyết định ai đọc
 * được: 'draft' = cá nhân (chỉ người tạo), 'public' = ghi chú của
 * khoá học, 'site' = ghi chú của site.
 */
export interface NoteRow {
  id: string;
  courseId: string | null;
  userId: string;
  createdBy: string;
  content: string;
  format: number;
  publishState: string;
  groupId: string | null;
  userModified: string | null;
  created: Date;
  lastModified: Date;
}

/** Dữ kiện ghi một ghi chú mới. */
export interface NewNote {
  id?: string;
  courseId?: string | null;
  userId: string;
  createdBy: string;
  content?: string;
  format?: number;
  publishState?: string;
  groupId?: string | null;
  userModified?: string | null;
  created?: Date;
  lastModified?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng bộ sưu tập thẻ. */
const TAG_COLLECTION_COLUMNS = [
  'id',
  'name',
  'is_standard as isStandard',
  'component',
  'searchable',
  'custom_url as customUrl',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng thẻ. */
const TAG_COLUMNS = [
  'id',
  'user_id as userId',
  'tag_coll_id as tagCollId',
  'name',
  'raw_name as rawName',
  'is_standard as isStandard',
  'flag',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng gắn thẻ. */
const TAG_INSTANCE_COLUMNS = [
  'id',
  'tag_id as tagId',
  'component',
  'item_type as itemType',
  'item_id as itemId',
  'context_id as contextId',
  'ti_user_id as tiUserId',
  'ordering',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng tương quan thẻ. */
const TAG_CORRELATION_COLUMNS = ['tag_id as tagId', 'correlated_tags as correlatedTags'] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng bình luận. */
const COMMENT_COLUMNS = [
  'id',
  'context_id as contextId',
  'component',
  'comment_area as commentArea',
  'item_id as itemId',
  'content',
  'format',
  'user_id as userId',
  'created_at as createdAt',
  'time_deleted as timeDeleted',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng đánh giá. */
const RATING_COLUMNS = [
  'id',
  'context_id as contextId',
  'component',
  'rating_area as ratingArea',
  'item_id as itemId',
  'scale_id as scaleId',
  'rating',
  'user_id as userId',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng ghi chú (hai cột mốc tên là `created`/`last_modified`). */
const NOTE_COLUMNS = [
  'id',
  'course_id as courseId',
  'user_id as userId',
  'created_by as createdBy',
  'content',
  'format',
  'publish_state as publishState',
  'group_id as groupId',
  'user_modified as userModified',
  'created',
  'last_modified as lastModified',
] as const;

/** Ánh xạ dữ kiện ghi thẻ (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function tagInsertValues(values: NewTag): Insertable<CentreDB['tag']> {
  const row: Insertable<CentreDB['tag']> = { name: values.name, raw_name: values.rawName };
  if (values.id !== undefined) row.id = values.id;
  if (values.userId !== undefined) row.user_id = values.userId;
  if (values.tagCollId !== undefined) row.tag_coll_id = values.tagCollId;
  if (values.isStandard !== undefined) row.is_standard = values.isStandard;
  if (values.flag !== undefined) row.flag = values.flag;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ dữ kiện gắn thẻ (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function tagInstanceInsertValues(values: NewTagInstance): Insertable<CentreDB['tag_instance']> {
  const row: Insertable<CentreDB['tag_instance']> = {
    tag_id: values.tagId,
    component: values.component,
    item_type: values.itemType,
    item_id: values.itemId,
    context_id: values.contextId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.tiUserId !== undefined) row.ti_user_id = values.tiUserId;
  if (values.ordering !== undefined) row.ordering = values.ordering;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ dữ kiện ghi bình luận (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function commentInsertValues(values: NewComment): Insertable<CentreDB['comments']> {
  const row: Insertable<CentreDB['comments']> = {
    context_id: values.contextId,
    component: values.component,
    comment_area: values.commentArea,
    item_id: values.itemId,
    content: values.content,
    user_id: values.userId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.format !== undefined) row.format = values.format;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.timeDeleted !== undefined) row.time_deleted = values.timeDeleted;
  return row;
}

/** Ánh xạ dữ kiện ghi đánh giá (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function ratingInsertValues(values: NewRating): Insertable<CentreDB['rating']> {
  const row: Insertable<CentreDB['rating']> = {
    context_id: values.contextId,
    component: values.component,
    rating_area: values.ratingArea,
    item_id: values.itemId,
    scale_id: values.scaleId,
    rating: values.rating,
    user_id: values.userId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ dữ kiện ghi ghi chú (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function noteInsertValues(values: NewNote): Insertable<CentreDB['notes']> {
  const row: Insertable<CentreDB['notes']> = { user_id: values.userId, created_by: values.createdBy };
  if (values.id !== undefined) row.id = values.id;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.content !== undefined) row.content = values.content;
  if (values.format !== undefined) row.format = values.format;
  if (values.publishState !== undefined) row.publish_state = values.publishState;
  if (values.groupId !== undefined) row.group_id = values.groupId;
  if (values.userModified !== undefined) row.user_modified = values.userModified;
  if (values.created !== undefined) row.created = values.created;
  if (values.lastModified !== undefined) row.last_modified = values.lastModified;
  return row;
}

/**
 * Repository xã hội trên Kysely: thẻ + gắn thẻ + tương quan, bình
 * luận, đánh giá và ghi chú khoá học của kho trung tâm.
 */
export class SocialRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm qua handle của repository. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  // --- thẻ ----------------------------------------------------------------------

  /** Đảm bảo bộ sưu tập thẻ mặc định tồn tại; trả về id của nó (tạo mới khi chưa có). */
  async ensureDefaultCollection(db: RepoDb = this.db()): Promise<string> {
    const existing = await db
      .selectFrom('tag_collection')
      .select(TAG_COLLECTION_COLUMNS)
      .where('name', '=', 'Default collection')
      .limit(1)
      .executeTakeFirst();
    if (existing) return existing.id;
    const rows = await db
      .insertInto('tag_collection')
      .values({ name: 'Default collection', is_standard: true })
      .returning(TAG_COLLECTION_COLUMNS)
      .execute();
    return rows[0]!.id;
  }

  /** Liệt kê bộ sưu tập thẻ, theo id tăng dần. */
  async listCollections(db: RepoDb = this.db()): Promise<TagCollectionRow[]> {
    return db.selectFrom('tag_collection').select(TAG_COLLECTION_COLUMNS).orderBy('id', 'asc').execute();
  }

  /** Tìm thẻ theo tên trong một bộ sưu tập. */
  async findTag(tagCollId: string, name: string, db: RepoDb = this.db()): Promise<TagRow | undefined> {
    return db
      .selectFrom('tag')
      .select(TAG_COLUMNS)
      .where('tag_coll_id', '=', tagCollId)
      .where('name', '=', name)
      .limit(1)
      .executeTakeFirst();
  }

  /** Chèn thẻ (chính thức hoặc cá nhân). */
  async insertTag(values: NewTag, db: RepoDb = this.db()): Promise<TagRow> {
    const rows = await db.insertInto('tag').values(tagInsertValues(values)).returning(TAG_COLUMNS).execute();
    return rows[0]!;
  }

  /** Lấy thẻ theo id. */
  async getTag(id: string, db: RepoDb = this.db()): Promise<TagRow | undefined> {
    return db.selectFrom('tag').select(TAG_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Các lần gắn thẻ của một item, theo thứ tự gắn tăng dần. */
  async listInstancesForItem(
    component: string,
    itemType: string,
    itemId: string,
    db: RepoDb = this.db(),
  ): Promise<TagInstanceRow[]> {
    return db
      .selectFrom('tag_instance')
      .select(TAG_INSTANCE_COLUMNS)
      .where('component', '=', component)
      .where('item_type', '=', itemType)
      .where('item_id', '=', itemId)
      .orderBy('ordering', 'asc')
      .execute();
  }

  /** Các item đã gắn một thẻ. */
  async listInstancesForTag(tagId: string, db: RepoDb = this.db()): Promise<TagInstanceRow[]> {
    return db
      .selectFrom('tag_instance')
      .select(TAG_INSTANCE_COLUMNS)
      .where('tag_id', '=', tagId)
      .execute();
  }

  /**
   * Gắn thẻ vào item. Chỉ số duy nhất sáu cột của bảng khiến lần
   * gắn trùng là no-op: insert bỏ qua khi trùng (`doNothing`
   * không trả dòng nào) thì đọc lại dòng đã có theo đúng khoá tự
   * nhiên — nhánh `ti_user_id` phân biệt tường minh: có user thì
   * so bằng, không có thì `IS NULL`, giữ nguyên hai nhánh của
   * đường Drizzle trước đây.
   */
  async insertInstance(values: NewTagInstance, db: RepoDb = this.db()): Promise<TagInstanceRow> {
    const rows = await db
      .insertInto('tag_instance')
      .values(tagInstanceInsertValues(values))
      .onConflict((oc) =>
        oc.columns(['tag_id', 'component', 'item_type', 'item_id', 'context_id', 'ti_user_id']).doNothing(),
      )
      .returning(TAG_INSTANCE_COLUMNS)
      .execute();
    if (rows[0]) return rows[0];
    let query = db
      .selectFrom('tag_instance')
      .select(TAG_INSTANCE_COLUMNS)
      .where('tag_id', '=', values.tagId)
      .where('component', '=', values.component)
      .where('item_type', '=', values.itemType)
      .where('item_id', '=', values.itemId)
      .where('context_id', '=', values.contextId);
    query = values.tiUserId ? query.where('ti_user_id', '=', values.tiUserId) : query.where('ti_user_id', 'is', null);
    const existing = await query.limit(1).executeTakeFirst();
    return existing!;
  }

  /** Gỡ mọi thẻ của một item trong một context. */
  async deleteInstancesForItem(
    component: string,
    itemType: string,
    itemId: string,
    contextId: string,
    db: RepoDb = this.db(),
  ): Promise<void> {
    await db
      .deleteFrom('tag_instance')
      .where('component', '=', component)
      .where('item_type', '=', itemType)
      .where('item_id', '=', itemId)
      .where('context_id', '=', contextId)
      .execute();
  }

  /** Ghi độ tương quan giữa các thẻ (thẻ liên quan): một dòng duy nhất theo thẻ, ghi đè khi đã có. */
  async upsertCorrelation(tagId: string, correlatedTags: string, db: RepoDb = this.db()): Promise<void> {
    await db
      .insertInto('tag_correlation')
      .values({ tag_id: tagId, correlated_tags: correlatedTags })
      .onConflict((oc) => oc.column('tag_id').doUpdateSet({ correlated_tags: correlatedTags }))
      .execute();
  }

  /** Độ tương quan đã lưu của một thẻ. */
  async getCorrelation(tagId: string, db: RepoDb = this.db()): Promise<TagCorrelationRow | undefined> {
    return db
      .selectFrom('tag_correlation')
      .select(TAG_CORRELATION_COLUMNS)
      .where('tag_id', '=', tagId)
      .limit(1)
      .executeTakeFirst();
  }

  // --- bình luận ------------------------------------------------------------------

  /** Chèn bình luận. */
  async insertComment(values: NewComment, db: RepoDb = this.db()): Promise<CommentRow> {
    const rows = await db
      .insertInto('comments')
      .values(commentInsertValues(values))
      .returning(COMMENT_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy bình luận theo id. */
  async getComment(id: string, db: RepoDb = this.db()): Promise<CommentRow | undefined> {
    return db.selectFrom('comments').select(COMMENT_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Bình luận còn hiệu lực của một item theo context, mới nhất trước. */
  async listComments(
    component: string,
    commentArea: string,
    itemId: string,
    contextId: string,
    db: RepoDb = this.db(),
  ): Promise<CommentRow[]> {
    return db
      .selectFrom('comments')
      .select(COMMENT_COLUMNS)
      .where('component', '=', component)
      .where('comment_area', '=', commentArea)
      .where('item_id', '=', itemId)
      .where('context_id', '=', contextId)
      .where('time_deleted', 'is', null)
      .orderBy('id', 'desc')
      .execute();
  }

  /** Xoá mềm bình luận: đặt mốc `time_deleted`, dòng vẫn còn để truy vết. */
  async softDeleteComment(id: string, db: RepoDb = this.db()): Promise<void> {
    await db.updateTable('comments').set({ time_deleted: new Date() }).where('id', '=', id).execute();
  }

  // --- đánh giá -------------------------------------------------------------------

  /**
   * Ghi/cập nhật đánh giá của một user cho một item: trùng khoá tự
   * nhiên năm cột thì cập nhật điểm, thang và mốc sửa thay vì tạo
   * dòng thứ hai.
   */
  async upsertRating(values: NewRating, db: RepoDb = this.db()): Promise<RatingRow> {
    const rows = await db
      .insertInto('rating')
      .values(ratingInsertValues(values))
      .onConflict((oc) =>
        oc
          .columns(['context_id', 'component', 'rating_area', 'item_id', 'user_id'])
          .doUpdateSet({ rating: values.rating, scale_id: values.scaleId, updated_at: new Date() }),
      )
      .returning(RATING_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Đánh giá của một item, theo id tăng dần. */
  async listRatings(
    component: string,
    ratingArea: string,
    itemId: string,
    contextId: string,
    db: RepoDb = this.db(),
  ): Promise<RatingRow[]> {
    return db
      .selectFrom('rating')
      .select(RATING_COLUMNS)
      .where('component', '=', component)
      .where('rating_area', '=', ratingArea)
      .where('item_id', '=', itemId)
      .where('context_id', '=', contextId)
      .orderBy('id', 'asc')
      .execute();
  }

  // --- ghi chú --------------------------------------------------------------------

  /** Chèn ghi chú khoá học. */
  async insertNote(values: NewNote, db: RepoDb = this.db()): Promise<NoteRow> {
    const rows = await db.insertInto('notes').values(noteInsertValues(values)).returning(NOTE_COLUMNS).execute();
    return rows[0]!;
  }

  /** Lấy ghi chú theo id. */
  async getNote(id: string, db: RepoDb = this.db()): Promise<NoteRow | undefined> {
    return db.selectFrom('notes').select(NOTE_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Ghi chú viết về một user, mới nhất trước. */
  async listNotesAbout(userId: string, db: RepoDb = this.db()): Promise<NoteRow[]> {
    return db
      .selectFrom('notes')
      .select(NOTE_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('id', 'desc')
      .execute();
  }

  /** Xoá ghi chú. */
  async deleteNote(id: string, db: RepoDb = this.db()): Promise<void> {
    await db.deleteFrom('notes').where('id', '=', id).execute();
  }
}
