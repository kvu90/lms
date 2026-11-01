import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  spaceJoinCodeDirectory,
  spaceMembershipDirectory,
  spaceRegistry,
  spaceRegistryHistory,
  spaceSchemaMigrationRuns,
  spaceSchemaRegistry,
  type SpaceJoinCodeDirectoryRow,
  type SpaceMembershipDirectoryRow,
  type SpaceRegistryHistoryRow,
  type SpaceRegistryRow,
  type SpaceRegistrySnapshot,
  type SpaceSchemaMigrationRunRow,
  type SpaceSchemaRegistryRow,
} from '@lms/db/control-plane';
import { and, asc, desc, eq, ne, or } from 'drizzle-orm';
import { ControlPlaneConnection, type ControlPlaneDatabase } from './control-plane.connection';

/** Handle transaction của control plane — cùng khuôn `DbTx` của kho nghiệp vụ nhưng trên kết nối riêng. */
export type CpTx = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0];
/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính kết nối gốc. */
export type CpDb = ControlPlaneDatabase | CpTx;

/** Tên chỉ số duy nhất riêng phần trên `space_registry.database_name` (chỉ phủ hàng dedicated). */
export const DEDICATED_DATABASE_NAME_UNIQUE_INDEX = 'space_registry_database_name_dedicated_unique';

/**
 * Lỗi có phải va chạm ĐÚNG chỉ số duy nhất riêng phần của tên
 * database dedicated hay không.
 *
 * PostgreSQL báo lỗi vi phạm unique bằng mã 23505; lỗi Drizzle có
 * thể bọc lỗi gốc qua `cause` nên phải duyệt cả chuỗi cause (cùng
 * mẫu các service khác trong repo). Mã 23505 một mình chưa đủ: chỉ
 * khi tên ràng buộc là chỉ số dedicated mới là va chạm này — các vi
 * phạm unique khác (ví dụ slug) không được nuốt thành "trùng tên
 * database".
 *
 * @param err - Lỗi bắt được từ thao tác ghi đăng ký.
 * @returns true khi lỗi là va chạm của chỉ số dedicated.
 */
export function isDedicatedDatabaseNameConflict(err: unknown): boolean {
  let e: unknown = err;
  while (e !== null && typeof e === 'object') {
    const candidate = e as { code?: unknown; constraint?: unknown; message?: unknown };
    if (candidate.code === '23505'
      && (candidate.constraint === DEDICATED_DATABASE_NAME_UNIQUE_INDEX
        || (typeof candidate.message === 'string' && candidate.message.includes(DEDICATED_DATABASE_NAME_UNIQUE_INDEX)))) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

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
   * Tra cứu dòng đăng ký theo tên database đích — đường kiểm tra trùng
   * của cấp phát (issue #583, ghi chú điều phối 6528534235): một tên
   * database không được hai dòng đăng ký cùng dùng. Lưu ý: tra cứu
   * này phủ CẢ hàng shared (kho chung vốn được nhiều dòng cùng trỏ)
   * vì tầng ứng dụng từ chối mọi databaseName đã có khi cấp phát
   * kho dedicated — một kho dedicated mang tên trùng kho chung sẽ
   * khiến trung tâm đó trỏ thẳng vào kho chung. Chỉ số duy nhất
   * riêng phần trên database chỉ là chốt chặn cho cuộc đua
   * dedicated-vs-dedicated; kiểm tra ở đây là lớp chính.
   */
  async findSpaceByDatabaseName(databaseName: string, db: CpDb = this.db()): Promise<SpaceRegistryRow | undefined> {
    const [row] = await db.select().from(spaceRegistry).where(eq(spaceRegistry.databaseName, databaseName)).limit(1);
    return row;
  }

  /**
   * Tra cứu dòng đăng ký KHÁC theo tên database đích — đường kiểm tra
   * trùng của cập nhật (issue #583, phán quyết vòng chấm lại hẹp thứ
   * hai PR #611): khi kiểm tra một dòng đang cập nhật, dòng đó PHẢI
   * bị loại trừ NGAY TRONG TRUY VẤN (`id <> ...`). Tra cứu `LIMIT 1`
   * không loại trừ có thể trả về chính dòng đang sửa — hai dòng cùng
   * tên là tiền đề thật vì các không gian kho chung cùng trỏ vào một
   * database — khiến điều kiện `clash.id !== id` bỏ qua va chạm với
   * dòng còn lại, mà chỉ số duy nhất riêng phần không cứu được vì
   * dòng còn lại vẫn là `shared`. Lọc bằng code sau `LIMIT 1` không
   * sửa được lỗi này vì dòng còn lại có thể đã bị truy vấn bỏ qua.
   */
  async findOtherSpaceByDatabaseName(
    databaseName: string,
    excludeId: string,
    db: CpDb = this.db(),
  ): Promise<SpaceRegistryRow | undefined> {
    const [row] = await db
      .select()
      .from(spaceRegistry)
      .where(and(eq(spaceRegistry.databaseName, databaseName), ne(spaceRegistry.id, excludeId)))
      .limit(1);
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

  // --- thư mục định tuyến của không gian kho riêng (issue #587, hạng mục 3) ---

  /**
   * Control plane đã cấu hình hay chưa — các đường đọc thư mục
   * dùng để tự bỏ qua khi hệ chưa có control plane (thế giới
   * trước định tuyến theo kho: mọi không gian ở kho chung, thư
   * mục rỗng theo định nghĩa), thay vì ném `control_plane.not_configured`
   * vào các luồng nghiệp vụ vốn không cần control plane.
   */
  isConfigured(): boolean {
    return this.connection.isConfigured;
  }

  /**
   * Ghi/đè một mục thư mục thành viên cho cặp (tài khoản toàn
   * cục, không gian): khoá duy nhất của cặp khiến mọi điểm ghi
   * (thêm thành viên, tạo người dùng trong kho riêng, cấp phát,
   * lấp thư mục) đều hội tụ về đúng một dòng — chạy lại không
   * nhân đôi. `spaceUserId` và `status` luôn lấy theo giá trị
   * mới nhất bên gọi cung cấp (trạng thái ở kho đích tại thời
   * điểm đồng bộ).
   */
  async upsertMembershipDirectory(
    values: { globalUserId: string; spaceSlug: string; spaceUserId: string; status: string },
    db: CpDb = this.db(),
  ): Promise<SpaceMembershipDirectoryRow> {
    const [row] = await db
      .insert(spaceMembershipDirectory)
      .values(values)
      .onConflictDoUpdate({
        target: [spaceMembershipDirectory.globalUserId, spaceMembershipDirectory.spaceSlug],
        set: { spaceUserId: values.spaceUserId, status: values.status, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /**
   * Đồng bộ trạng thái của một mục thư mục thành viên đã có
   * (điểm đổi trạng thái membership): chỉ cập nhật khi mục tồn
   * tại — trạng thái membership đổi ở nơi chưa từng có mục thư
   * mục không tự sinh mục mới ở đây, vì mục mới phải mang cả
   * `spaceUserId` do điểm ghi có đủ dữ kiện quyết định. Trả về
   * số dòng đã cập nhật (0 = không có mục).
   */
  async updateMembershipDirectoryStatus(
    globalUserId: string,
    spaceSlug: string,
    status: string,
    db: CpDb = this.db(),
  ): Promise<number> {
    const updated = await db
      .update(spaceMembershipDirectory)
      .set({ status, updatedAt: new Date() })
      .where(
        and(eq(spaceMembershipDirectory.globalUserId, globalUserId), eq(spaceMembershipDirectory.spaceSlug, spaceSlug)),
      )
      .returning({ id: spaceMembershipDirectory.id });
    return updated.length;
  }

  /**
   * Mọi mục thư mục thành viên của một người: khớp theo định
   * danh toàn cục (tài khoản ở kho chung tra bộ chọn sau khi
   * trung tâm đã chuyển) HOẶC theo định danh tại kho đích
   * (phiên của chính kho riêng gọi bộ chọn — định danh người
   * gọi lúc đó là `spaceUserId`). Một mục khớp cả hai chiều vẫn
   * chỉ trả một dòng (điều kiện OR trên cùng một dòng).
   */
  async listMembershipDirectoryForUser(userId: string, db: CpDb = this.db()): Promise<SpaceMembershipDirectoryRow[]> {
    return db
      .select()
      .from(spaceMembershipDirectory)
      .where(or(eq(spaceMembershipDirectory.globalUserId, userId), eq(spaceMembershipDirectory.spaceUserId, userId)))
      .orderBy(asc(spaceMembershipDirectory.createdAt), asc(spaceMembershipDirectory.id));
  }

  /** Tra một mã tham gia trong thư mục: trả dòng thư mục hoặc undefined khi mã chưa đăng ký. */
  async findJoinCodeDirectory(joinCode: string, db: CpDb = this.db()): Promise<SpaceJoinCodeDirectoryRow | undefined> {
    const [row] = await db.select().from(spaceJoinCodeDirectory).where(eq(spaceJoinCodeDirectory.joinCode, joinCode)).limit(1);
    return row;
  }

  /**
   * Đăng ký một mã tham gia cho một không gian, giữ tính duy
   * nhất toàn hệ của mã bằng chính ràng buộc duy nhất của bảng:
   * - `claimed`: mã chưa có — dòng vừa ghi thuộc về không gian này.
   * - `already`: mã đã đăng ký cho CHÍNH không gian này (ghi lại
   *   cùng trạng thái — idempotent).
   * - `conflict`: mã đã thuộc về một không gian khác — bên gọi
   *   phải từ chối thao tác đặt mã, tuyệt đối không ghi đè.
   */
  async claimJoinCodeDirectory(
    joinCode: string,
    spaceSlug: string,
    db: CpDb = this.db(),
  ): Promise<'claimed' | 'already' | 'conflict'> {
    const [inserted] = await db
      .insert(spaceJoinCodeDirectory)
      .values({ joinCode, spaceSlug })
      .onConflictDoNothing({ target: spaceJoinCodeDirectory.joinCode })
      .returning();
    if (inserted) return 'claimed';
    const existing = await this.findJoinCodeDirectory(joinCode, db);
    return existing && existing.spaceSlug === spaceSlug ? 'already' : 'conflict';
  }

  /** Gỡ một mã khỏi thư mục (mã bị đổi hoặc lớp bị xoá); mã không có trong thư mục thì không làm gì. */
  async deleteJoinCodeDirectory(joinCode: string, db: CpDb = this.db()): Promise<void> {
    await db.delete(spaceJoinCodeDirectory).where(eq(spaceJoinCodeDirectory.joinCode, joinCode));
  }

  /** Mọi mã đã đăng ký cho một không gian (công cụ lấp thư mục đối chiếu sau khi chạy). */
  async listJoinCodeDirectoryForSpace(spaceSlug: string, db: CpDb = this.db()): Promise<SpaceJoinCodeDirectoryRow[]> {
    return db
      .select()
      .from(spaceJoinCodeDirectory)
      .where(eq(spaceJoinCodeDirectory.spaceSlug, spaceSlug))
      .orderBy(asc(spaceJoinCodeDirectory.joinCode));
  }
}
