import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  spaceRegistry,
  spaceRegistryHistory,
  spaceSchemaMigrationRuns,
  spaceSchemaRegistry,
  type SpaceRegistryHistoryRow,
  type SpaceRegistryRow,
  type SpaceRegistrySnapshot,
  type SpaceSchemaMigrationRunRow,
  type SpaceSchemaRegistryRow,
} from '@lms/db/control-plane';
import { asc, desc, eq } from 'drizzle-orm';
import { ControlPlaneConnection, type ControlPlaneDatabase } from './control-plane.connection';

/** Handle transaction của control plane — cùng khuôn `DbTx` của kho nghiệp vụ nhưng trên kết nối riêng. */
export type CpTx = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0];
/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính kết nối gốc. */
export type CpDb = ControlPlaneDatabase | CpTx;

/** Dữ kiện ghi một dòng đăng ký mới (đã qua kiểm chứng ở tầng service/contract). */
export type NewSpaceRegistration = typeof spaceRegistry.$inferInsert;
/** Dữ kiện ghi một lượt chạy migration. */
export type NewSchemaMigrationRun = typeof spaceSchemaMigrationRuns.$inferInsert;

/**
 * Repository của control plane (issue #580): mọi truy cập tới bốn
 * bảng của database control plane tập trung ở đây. Repository không
 * chứa luật nghiệp vụ — gác quyền, ghi lịch sử và giao dịch nằm ở
 * `ControlPlaneRegistryService`; repository chỉ nhận handle (kết nối
 * gốc hoặc transaction) để service ghép nhiều thao tác vào một
 * transaction khi cần bất biến "sổ + lịch sử cùng thành/bại".
 */
@Injectable()
export class ControlPlaneRepository {
  constructor(private readonly connection: ControlPlaneConnection) {}

  /** Kết nối gốc; ném lỗi rõ ràng khi control plane chưa được cấu hình. */
  private db(): ControlPlaneDatabase {
    if (!this.connection.db) {
      throw new ServiceUnavailableException({
        message: 'Control plane database is not configured',
        code: 'control_plane.not_configured',
      });
    }
    return this.connection.db;
  }

  /** Mở một transaction trên database control plane. */
  async transaction<T>(fn: (tx: CpTx) => Promise<T>): Promise<T> {
    return this.db().transaction(fn);
  }

  /**
   * Thêm dòng đăng ký nếu slug chưa có; trả về dòng vừa thêm, hoặc
   * undefined khi slug đã tồn tại. Cả hai đường ghi dùng nhánh này:
   * đường gieo dữ kiện (chạy lại không tạo trùng, không ghi đè dữ
   * kiện đã có) và đường tạo qua API — insert-bỏ-qua-khi-trùng ngay
   * trong transaction khiến hai lượt tạo đồng thời cùng slug chỉ
   * một lượt thành công, lượt còn lại được báo xung đột thay vì vấp
   * ràng buộc unique thành lỗi máy chủ.
   */
  async insertSpaceIfAbsent(values: NewSpaceRegistration, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    const [row] = await db.insert(spaceRegistry).values(values).onConflictDoNothing({ target: spaceRegistry.slug }).returning();
    return row;
  }

  /** Cập nhật một dòng đăng ký theo id và trả về dòng sau cập nhật. */
  async updateSpace(id: string, patch: Partial<NewSpaceRegistration>, db: CpDb = this.db()): Promise<SpaceRegistryRow> {
    const [row] = await db
      .update(spaceRegistry)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(spaceRegistry.id, id))
      .returning();
    return row!;
  }

  async findSpaceById(id: string, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    const [row] = await db.select().from(spaceRegistry).where(eq(spaceRegistry.id, id)).limit(1);
    return row;
  }

  /**
   * Đọc một dòng đăng ký KÈM KHOÁ DÒNG (`FOR UPDATE`) — chỉ dùng
   * bên trong transaction: thao tác ghi nào đọc dòng này để hợp nhất
   * / chụp ảnh `before` đều phải đọc qua đây, để hai thao tác ghi
   * đồng thời trên cùng một dòng nối tiếp nhau thay vì cùng đọc một
   * ảnh cũ rồi ghi đè lẫn nhau (mất dữ kiện, chuỗi lịch sử đứt).
   */
  async findSpaceByIdForUpdate(id: string, db: CpDb): Promise<SpaceRegistryRow | undefined> {
    const [row] = await db.select().from(spaceRegistry).where(eq(spaceRegistry.id, id)).limit(1).for('update');
    return row;
  }

  /** Tra cứu định tuyến theo slug — đường đọc chính của tầng ứng dụng. */
  async findSpaceBySlug(slug: string, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    const [row] = await db.select().from(spaceRegistry).where(eq(spaceRegistry.slug, slug)).limit(1);
    return row;
  }

  /**
   * Toàn bộ sổ đăng ký theo thứ tự slug (issue #586): đầu vào của
   * các công cụ vận hành đội kho — runner migration đọc danh sách
   * kho + phiên bản hiện tại từ đây, tác vụ sao lưu và kiểm thử
   * khôi phục cũng duyệt cùng danh sách này. Thứ tự slug cố định để
   * mọi lượt chạy duyệt các kho theo cùng một thứ tự xác định.
   */
  async listSpaces(db: CpDb = this.db()): Promise<SpaceRegistryRow[]> {
    return db.select().from(spaceRegistry).orderBy(asc(spaceRegistry.slug));
  }

  /** Ghi một dòng lịch sử quản trị (gọi trong cùng transaction với thay đổi trên sổ). */
  async insertHistory(
    values: { spaceId: string; actorId: string; action: string; before: SpaceRegistrySnapshot | null; after: SpaceRegistrySnapshot },
    db: CpDb = this.db(),
  ): Promise<SpaceRegistryHistoryRow> {
    const [row] = await db.insert(spaceRegistryHistory).values(values).returning();
    return row!;
  }

  /** Lịch sử quản trị của một không gian, mới nhất trước. */
  async listHistory(spaceId: string, db: CpDb = this.db()): Promise<SpaceRegistryHistoryRow[]> {
    return db
      .select()
      .from(spaceRegistryHistory)
      .where(eq(spaceRegistryHistory.spaceId, spaceId))
      .orderBy(desc(spaceRegistryHistory.createdAt), desc(spaceRegistryHistory.id));
  }

  /** Trạng thái schema của một kho; undefined khi chưa có dòng registry cho kho đó. */
  async findSchemaRegistry(spaceId: string, db: CpDb = this.db()): Promise<SpaceSchemaRegistryRow | undefined> {
    const [row] = await db.select().from(spaceSchemaRegistry).where(eq(spaceSchemaRegistry.spaceId, spaceId)).limit(1);
    return row;
  }

  /** Ghi/đè trạng thái schema của một kho (một dòng duy nhất theo khoá chính spaceId). */
  async upsertSchemaRegistry(
    values: typeof spaceSchemaRegistry.$inferInsert,
    db: CpDb = this.db(),
  ): Promise<SpaceSchemaRegistryRow> {
    const [row] = await db
      .insert(spaceSchemaRegistry)
      .values(values)
      .onConflictDoUpdate({
        target: spaceSchemaRegistry.spaceId,
        set: {
          currentVersion: values.currentVersion,
          lastBackupStatus: values.lastBackupStatus,
          lastBackupAt: values.lastBackupAt,
          lastRestoreStatus: values.lastRestoreStatus,
          lastRestoreAt: values.lastRestoreAt,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  /** Đảm bảo có dòng registry phiên bản schema cho kho (đường gieo dữ kiện; đã có thì giữ nguyên). */
  async ensureSchemaRegistry(spaceId: string, currentVersion: string, db: CpDb = this.db()): Promise<void> {
    await db
      .insert(spaceSchemaRegistry)
      .values({ spaceId, currentVersion })
      .onConflictDoNothing({ target: spaceSchemaRegistry.spaceId });
  }

  /** Thêm một lượt chạy migration vào nhật ký (chỉ thêm, không sửa dòng cũ). */
  async insertMigrationRun(values: NewSchemaMigrationRun, db: CpDb = this.db()): Promise<SpaceSchemaMigrationRunRow> {
    const [row] = await db.insert(spaceSchemaMigrationRuns).values(values).returning();
    return row!;
  }

  /** Các lượt chạy migration của một kho, cũ nhất trước (đúng thứ tự thời gian của nhật ký). */
  async listMigrationRuns(spaceId: string, db: CpDb = this.db()): Promise<SpaceSchemaMigrationRunRow[]> {
    return db
      .select()
      .from(spaceSchemaMigrationRuns)
      .where(eq(spaceSchemaMigrationRuns.spaceId, spaceId))
      .orderBy(asc(spaceSchemaMigrationRuns.startedAt), asc(spaceSchemaMigrationRuns.id));
  }
}
