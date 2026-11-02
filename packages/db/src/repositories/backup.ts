/**
 * Repository của cụm BACKUP trên Kysely — chuyển đổi Drizzle →
 * Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ liệu (issue
 * #648).
 *
 * Vai trò: mọi truy cập tới ba bảng backup_jobs, backup_job_steps
 * và backup_id_mappings của kho trung tâm tập trung ở đây. Phần dữ
 * liệu khoá học mà job sao lưu/khôi phục (contributor) nằm ở tầng
 * service phía ứng dụng, chạy trên chính handle mà repository này
 * phơi ra qua `dbHandle`. Repository không chứa luật nghiệp vụ —
 * cổng quyền, chế độ khôi phục và ánh xạ id nằm ở service.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo khuôn pilot kho
 * control plane): bên trong dùng tên bảng/cột snake_case của
 * schema codegen; bên ngoài nhận/trả hình dạng camelCase qua danh
 * sách cột có bí danh tường minh và các hàm ánh xạ
 * `*InsertValues`/`*UpdateSet` loại `undefined` từng trường (luật
 * T-4). Các cột jsonb (`archive`, `detail`) khi ghi đi qua
 * `jsonbValue` (serialize tường minh + `::jsonb`) vì `archive` là
 * một OBJECT lớn và `detail` cũng là object — một khuôn duy nhất
 * cho mọi giá trị jsonb, không phụ thuộc nhánh xử lý của driver.
 */
import { sql, type Insertable, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type BackupDb = CentreDb | CentreTx;

/** Một dòng job sao lưu/khôi phục (archive là toàn bộ bản sao lưu dạng jsonb). */
export interface JobRow {
  id: string;
  type: string;
  scope: string;
  courseId: string | null;
  targetCourseId: string | null;
  mode: string;
  status: string;
  anonymize: boolean;
  userId: string;
  /** Toàn bộ bản sao lưu (jsonb) — chỉ có ở job backup đã hoàn tất. */
  archive: unknown | null;
  error: string | null;
  createdAt: Date;
  timeFinished: Date | null;
}

/** Một dòng bước chạy của một job (một contributor = một bước). */
export interface StepRow {
  id: string;
  jobId: string;
  name: string;
  status: string;
  /** Chi tiết kết quả của bước (jsonb). */
  detail: unknown | null;
  createdAt: Date;
}

/** Một dòng ánh xạ id cũ → id mới do một job khôi phục tạo ra. */
export interface MappingRow {
  id: string;
  jobId: string;
  itemType: string;
  oldId: string;
  newId: string;
}

/** Dữ kiện ghi một job mới. */
export interface NewJob {
  id?: string;
  type: string;
  scope?: string;
  courseId?: string | null;
  targetCourseId?: string | null;
  mode?: string;
  status?: string;
  anonymize?: boolean;
  userId: string;
  archive?: unknown | null;
  error?: string | null;
  createdAt?: Date;
  timeFinished?: Date | null;
}

/** Dữ kiện ghi một bước mới. */
export interface NewStep {
  id?: string;
  jobId: string;
  name: string;
  status?: string;
  detail?: unknown | null;
  createdAt?: Date;
}

/** Dữ kiện ghi một ánh xạ id mới. */
export interface NewMapping {
  id?: string;
  jobId: string;
  itemType: string;
  oldId: string;
  newId: string;
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (serialize + `::jsonb`) — xem lý do ở phần đầu file.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb (hình
 *   dạng do phía gọi chịu trách nhiệm — các cột jsonb của cụm này
 *   không khai kiểu nghiệp vụ riêng ở schema).
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng backup_jobs. */
const JOB_COLUMNS = [
  'id',
  'type',
  'scope',
  'course_id as courseId',
  'target_course_id as targetCourseId',
  'mode',
  'status',
  'anonymize',
  'user_id as userId',
  'archive',
  'error',
  'created_at as createdAt',
  'time_finished as timeFinished',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng backup_job_steps. */
const STEP_COLUMNS = [
  'id',
  'job_id as jobId',
  'name',
  'status',
  'detail',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng backup_id_mappings. */
const MAPPING_COLUMNS = [
  'id',
  'job_id as jobId',
  'item_type as itemType',
  'old_id as oldId',
  'new_id as newId',
] as const;

/** Ánh xạ dữ kiện ghi job từ camelCase sang snake_case, loại `undefined` từng trường. */
function jobInsertValues(values: NewJob): InsertObject<CentreDB, 'backup_jobs'> {
  const row: InsertObject<CentreDB, 'backup_jobs'> = {
    type: values.type,
    user_id: values.userId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.scope !== undefined) row.scope = values.scope;
  if (values.courseId !== undefined) row.course_id = values.courseId;
  if (values.targetCourseId !== undefined) row.target_course_id = values.targetCourseId;
  if (values.mode !== undefined) row.mode = values.mode;
  if (values.status !== undefined) row.status = values.status;
  if (values.anonymize !== undefined) row.anonymize = values.anonymize;
  if (values.archive !== undefined) row.archive = jsonbValue(values.archive);
  if (values.error !== undefined) row.error = values.error;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.timeFinished !== undefined) row.time_finished = values.timeFinished;
  return row;
}

/** Ánh xạ bản vá job từ camelCase sang snake_case, loại `undefined` từng trường. */
function jobUpdateSet(patch: Partial<NewJob>): UpdateObject<CentreDB, 'backup_jobs'> {
  const set: UpdateObject<CentreDB, 'backup_jobs'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.scope !== undefined) set.scope = patch.scope;
  if (patch.courseId !== undefined) set.course_id = patch.courseId;
  if (patch.targetCourseId !== undefined) set.target_course_id = patch.targetCourseId;
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.anonymize !== undefined) set.anonymize = patch.anonymize;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.archive !== undefined) set.archive = jsonbValue(patch.archive);
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.timeFinished !== undefined) set.time_finished = patch.timeFinished;
  return set;
}

/** Ánh xạ dữ kiện ghi bước từ camelCase sang snake_case, loại `undefined` từng trường. */
function stepInsertValues(values: NewStep): InsertObject<CentreDB, 'backup_job_steps'> {
  const row: InsertObject<CentreDB, 'backup_job_steps'> = {
    job_id: values.jobId,
    name: values.name,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.status !== undefined) row.status = values.status;
  if (values.detail !== undefined) row.detail = jsonbValue(values.detail);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ bản vá bước từ camelCase sang snake_case, loại `undefined` từng trường. */
function stepUpdateSet(patch: Partial<NewStep>): UpdateObject<CentreDB, 'backup_job_steps'> {
  const set: UpdateObject<CentreDB, 'backup_job_steps'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.jobId !== undefined) set.job_id = patch.jobId;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.detail !== undefined) set.detail = jsonbValue(patch.detail);
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/** Ánh xạ dữ kiện ghi ánh xạ id từ camelCase sang snake_case, loại `undefined` từng trường. */
function mappingInsertValues(values: NewMapping): Insertable<CentreDB['backup_id_mappings']> {
  const row: Insertable<CentreDB['backup_id_mappings']> = {
    job_id: values.jobId,
    item_type: values.itemType,
    old_id: values.oldId,
    new_id: values.newId,
  };
  if (values.id !== undefined) row.id = values.id;
  return row;
}

/** Kho dữ liệu backup_jobs / backup_job_steps / backup_id_mappings. */
export class BackupRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle Kysely của kho trung tâm mà repository đang giữ (tầng service dùng cho các contributor sao lưu/khôi phục). */
  get dbHandle(): CentreDb {
    return this.handle;
  }

  /** Ghi một job mới, trả dòng vừa ghi. */
  async insertJob(v: NewJob, db: BackupDb = this.handle): Promise<JobRow> {
    const rows = await db
      .insertInto('backup_jobs')
      .values(jobInsertValues(v))
      .returning(JOB_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy job theo id. */
  async getJob(id: string, db: BackupDb = this.handle): Promise<JobRow | undefined> {
    return db
      .selectFrom('backup_jobs')
      .select(JOB_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi job. */
  async listJobs(db: BackupDb = this.handle): Promise<JobRow[]> {
    return db.selectFrom('backup_jobs').select(JOB_COLUMNS).execute();
  }

  /** Cập nhật một job theo bản vá từng phần. */
  async updateJob(id: string, v: Partial<NewJob>, db: BackupDb = this.handle): Promise<void> {
    await db
      .updateTable('backup_jobs')
      .set(jobUpdateSet(v))
      .where('id', '=', id)
      .execute();
  }

  /** Ghi một bước mới, trả dòng vừa ghi. */
  async insertStep(v: NewStep, db: BackupDb = this.handle): Promise<StepRow> {
    const rows = await db
      .insertInto('backup_job_steps')
      .values(stepInsertValues(v))
      .returning(STEP_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Liệt kê các bước của một job. */
  async listSteps(jobId: string, db: BackupDb = this.handle): Promise<StepRow[]> {
    return db
      .selectFrom('backup_job_steps')
      .select(STEP_COLUMNS)
      .where('job_id', '=', jobId)
      .execute();
  }

  /** Cập nhật một bước theo bản vá từng phần. */
  async updateStep(id: string, v: Partial<NewStep>, db: BackupDb = this.handle): Promise<void> {
    await db
      .updateTable('backup_job_steps')
      .set(stepUpdateSet(v))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Ghi một ánh xạ id; trùng bộ ba (job, loại, id cũ) thì cập nhật
   * id mới theo dữ kiện (upsert trên ràng buộc unique của bảng).
   */
  async insertMapping(v: NewMapping, db: BackupDb = this.handle): Promise<MappingRow> {
    const rows = await db
      .insertInto('backup_id_mappings')
      .values(mappingInsertValues(v))
      .onConflict((oc) => oc
        .columns(['job_id', 'item_type', 'old_id'])
        .doUpdateSet({ new_id: v.newId }))
      .returning(MAPPING_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Liệt kê các ánh xạ của một job. */
  async listMappings(jobId: string, db: BackupDb = this.handle): Promise<MappingRow[]> {
    return db
      .selectFrom('backup_id_mappings')
      .select(MAPPING_COLUMNS)
      .where('job_id', '=', jobId)
      .execute();
  }

  /** Tra một ánh xạ theo bộ ba (job, loại, id cũ). */
  async getMapping(jobId: string, itemType: string, oldId: string, db: BackupDb = this.handle): Promise<MappingRow | undefined> {
    return db
      .selectFrom('backup_id_mappings')
      .select(MAPPING_COLUMNS)
      .where('job_id', '=', jobId)
      .where('item_type', '=', itemType)
      .where('old_id', '=', oldId)
      .executeTakeFirst();
  }
}
