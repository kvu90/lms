import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  ChangeSpaceStatus,
  CreateSpaceRegistration,
  RecordSpaceSchemaMigrationRun,
  SpaceRegistration,
  SpaceRegistryHistoryEntry,
  SpaceSchemaMigrationRun,
  SpaceSchemaRegistry,
  UpdateSpaceRegistration,
  UpdateSpaceSchemaRegistry,
} from '@lms/contracts';
import type { SpaceRegistryRow } from '@lms/db/control-plane';
import { emitSpaceRegistryChanged } from '../../db/routing/space-routing-events';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ControlPlaneConnection } from './control-plane.connection';
import { ControlPlaneRepository, isDedicatedDatabaseNameConflict } from './control-plane.repository';

/**
 * Phiên bản schema hiện tại của KHO CHUNG (database nghiệp vụ) — tên
 * thư mục migration baseline duy nhất của kho đó. Dòng đăng ký của
 * các không gian đang ở chế độ `shared` mang phiên bản này cho tới
 * khi chúng tách sang kho riêng (chương trình tenant, issue #587).
 */
export const SHARED_DATABASE_SCHEMA_VERSION = '20261025163710_baseline';

/** Một không gian hiện hữu cần đảm bảo có dòng đăng ký khi gieo dữ kiện. */
export type ExistingSpaceSeed = {
  slug: string;
  name: string;
  kind: 'center' | 'platform';
  plan: string | null;
  databaseName: string;
  connectionRoleRef: string;
  secretRef: string;
};

/**
 * Service của control plane (issue #580): sổ đăng ký không gian và
 * registry phiên bản schema.
 *
 * Luồng nghiệp vụ chính:
 * - Ghi sổ (tạo / cập nhật / đổi trạng thái): gác bằng capability
 *   `tenant:manage` tại context HỆ THỐNG — cơ chế quản trị platform
 *   hiện hữu, tầng này không dựng mô hình tài khoản quản trị riêng.
 *   Mỗi thao tác ghi chạy trong MỘT transaction của database control
 *   plane: đổi dòng đăng ký + ghi đúng một dòng lịch sử (người thực
 *   hiện, thời gian, ảnh chụp trước/sau) — hai ghi cùng thành hoặc
 *   cùng huỷ, sổ và lịch sử không bao giờ lệch nhau.
 * - Đọc định tuyến theo slug: trả nguyên dòng đăng ký để tầng ứng
 *   dụng (và các issue định tuyến #581/#582 sau này) biết không gian
 *   đang ở kho nào, bằng role nào, ở phiên bản schema nào.
 * - Registry phiên bản schema: khung ghi/đọc trạng thái schema của
 *   từng kho (phiên bản hiện tại, lượt migration, trạng thái sao
 *   lưu/khôi phục gần nhất). Cơ chế tự động ghi thuộc issue #586.
 *
 * Mọi thao tác đều cần control plane đã cấu hình
 * (`CONTROL_PLANE_DATABASE_URL`); chưa cấu hình thì repository ném
 * `control_plane.not_configured` (503).
 */
@Injectable()
export class ControlPlaneRegistryService {
  private readonly logger = new Logger(ControlPlaneRegistryService.name);

  constructor(
    private readonly repo: ControlPlaneRepository,
    private readonly connection: ControlPlaneConnection,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
  ) {}

  /** Control plane đã được cấu hình kết nối hay chưa (điểm gieo dữ kiện hỏi trước khi ghi). */
  get isConfigured(): boolean {
    return this.connection.isConfigured;
  }

  /**
   * Gác quản trị platform: chỉ người giữ `tenant:manage` tại context
   * hệ thống mới được đọc/ghi sổ — cùng helper với bề mặt quản trị
   * tenant hiện hữu.
   */
  private async assertPlatformManager(actorId: string): Promise<void> {
    const systemId = (await this.contexts.ensureSystemContext()).id;
    await this.evaluator.requireCapability(actorId, 'tenant:manage', systemId);
  }

  /** Ảnh chụp một dòng đăng ký để ghi lịch sử (không kèm mốc thời gian của dòng). */
  private snapshot(row: SpaceRegistryRow): Omit<SpaceRegistration, 'createdAt' | 'updatedAt'> {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind as SpaceRegistration['kind'],
      status: row.status as SpaceRegistration['status'],
      databaseName: row.databaseName,
      storageMode: row.storageMode as SpaceRegistration['storageMode'],
      connectionRoleRef: row.connectionRoleRef,
      secretRef: row.secretRef,
      schemaVersion: row.schemaVersion,
      plan: row.plan,
    };
  }

  /** Ánh xạ dòng đăng ký sang hình dạng hợp đồng API. */
  private toRegistration(row: SpaceRegistryRow): SpaceRegistration {
    return {
      ...this.snapshot(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Tạo dòng đăng ký không gian mới + dòng lịch sử `create` trong
   * cùng transaction. Kiểm tra trùng slug có hai lớp: kiểm tra nhanh
   * ngoài transaction cho đường thường, và insert-bỏ-qua-khi-trùng
   * ngay trong transaction để hai lượt tạo đồng thời cùng slug chỉ
   * một lượt thành công — lượt còn lại nhận lỗi xung đột (409),
   * không vấp ràng buộc unique thành lỗi 500.
   */
  async createRegistration(actorId: string, dto: CreateSpaceRegistration): Promise<SpaceRegistration> {
    await this.assertPlatformManager(actorId);
    if (await this.repo.findSpaceBySlug(dto.slug)) {
      throw new ConflictException({ message: `Space slug ${dto.slug} is already registered`, code: 'control_plane.slug_taken' });
    }
    // Lớp kiểm tra trùng databaseName ở tầng ứng dụng (issue #583,
    // ghi chú điều phối 6528534235 — điểm P1-2b từ review PR #594):
    // một tên database không được hai dòng đăng ký cùng dùng, KỂ CẢ
    // khi một trong hai là hàng shared — đường cấp phát kho dedicated
    // mang tên trùng kho chung sẽ khiến trung tâm mới trỏ thẳng vào
    // kho chung thay vì kho riêng của nó. Chỉ số duy nhất riêng phần
    // trên database (chỉ phủ hàng dedicated) là chốt chặn cho cuộc
    // đua dedicated-vs-dedicated; kiểm tra ở đây bắt cả trường hợp
    // trùng với hàng shared mà chỉ số không phủ.
    if (await this.repo.findSpaceByDatabaseName(dto.databaseName)) {
      throw new ConflictException({ message: `Database name ${dto.databaseName} is already registered`, code: 'control_plane.database_name_taken' });
    }
    let created: SpaceRegistryRow;
    try {
      created = await this.repo.transaction(async (tx) => {
        const row = await this.repo.insertSpaceIfAbsent(
          {
            slug: dto.slug,
            name: dto.name,
            kind: dto.kind,
            status: dto.status ?? 'provisioning',
            databaseName: dto.databaseName,
            storageMode: dto.storageMode,
            connectionRoleRef: dto.connectionRoleRef,
            secretRef: dto.secretRef ?? null,
            schemaVersion: dto.schemaVersion ?? null,
            plan: dto.plan ?? null,
          },
          tx,
        );
        if (!row) {
          throw new ConflictException({ message: `Space slug ${dto.slug} is already registered`, code: 'control_plane.slug_taken' });
        }
        await this.repo.insertHistory({ spaceId: row.id, actorId, action: 'create', before: null, after: this.snapshot(row) }, tx);
        return row;
      });
    } catch (error) {
      // Chốt chặn cho cuộc đua dedicated-vs-dedicated: hai lượt tạo
      // đồng thời cùng databaseName đều qua được kiểm tra ngoài
      // transaction, lượt sau vấp chỉ số duy nhất riêng phần trong
      // transaction — ánh xạ thành 409 cùng mã với kiểm tra ngoài
      // thay vì để lỗi 500 rò ra ngoài. Mã 23505 một mình chưa đủ:
      // chỉ khi tên ràng buộc là chỉ số dedicated mới là va chạm
      // này; các vi phạm unique khác (ví dụ slug) giữ nguyên hành
      // vi cũ qua nhánh ConflictException bên trong transaction.
      if (isDedicatedDatabaseNameConflict(error)) {
        throw new ConflictException({ message: `Database name ${dto.databaseName} is already registered`, code: 'control_plane.database_name_taken' });
      }
      throw error;
    }
    // Sổ vừa có dòng mới: báo khung định tuyến (issue #581) vô hiệu
    // hoá đệm của slug này — phát SAU khi transaction đã commit để
    // bên nghe đọc lại được giá trị mới.
    emitSpaceRegistryChanged(created.slug);
    return this.toRegistration(created);
  }

  /**
   * Cập nhật các trường sửa được của một dòng đăng ký + dòng lịch
   * sử `update` trong cùng transaction. Dòng hiện tại được đọc LẠI
   * bên trong transaction kèm khoá dòng: ảnh `before` của lịch sử
   * vì vậy luôn là giá trị ngay trước lần ghi này kể cả khi có
   * thao tác ghi khác chạy đồng thời (đọc ngoài transaction sẽ
   * chụp phải ảnh cũ và làm chuỗi lịch sử đứt).
   *
   * Bất biến trùng tên database áp cho cả cập nhật như đường tạo:
   * đổi `databaseName` sang tên đã có ở dòng khác (kể cả dòng kho
   * chung — chỉ số duy nhất riêng phần chỉ phủ hàng dedicated nên
   * không bắt được ca này) thì bị từ chối 409 ngay trong
   * transaction, trước khi ghi. Đổi về chính tên hiện tại của dòng
   * thì không tính là trùng. Hai lượt cập nhật đồng thời cùng tên
   * dedicated thì lượt sau vấp chỉ số riêng phần trong transaction
   * và được ánh xạ thành cùng mã 409 như đường tạo.
   */
  async updateRegistration(actorId: string, id: string, dto: UpdateSpaceRegistration): Promise<SpaceRegistration> {
    await this.assertPlatformManager(actorId);
    let updated: SpaceRegistryRow;
    try {
      updated = await this.repo.transaction(async (tx) => {
        const existing = await this.repo.findSpaceByIdForUpdate(id, tx);
        if (!existing) {
          throw new NotFoundException({ message: `Space registration ${id} not found`, code: 'control_plane.space_not_found' });
        }
        if (dto.databaseName !== undefined && dto.databaseName !== existing.databaseName) {
          const clash = await this.repo.findSpaceByDatabaseName(dto.databaseName, tx);
          if (clash && clash.id !== id) {
            throw new ConflictException({ message: `Database name ${dto.databaseName} is already registered`, code: 'control_plane.database_name_taken' });
          }
        }
        const row = await this.repo.updateSpace(id, { ...dto }, tx);
        await this.repo.insertHistory(
          { spaceId: id, actorId, action: 'update', before: this.snapshot(existing), after: this.snapshot(row) },
          tx,
        );
        return row;
      });
    } catch (error) {
      if (isDedicatedDatabaseNameConflict(error)) {
        throw new ConflictException({ message: `Database name ${dto.databaseName} is already registered`, code: 'control_plane.database_name_taken' });
      }
      throw error;
    }
    // Cập nhật có thể đổi đích định tuyến (database/role/chế độ
    // kho): vô hiệu hoá đệm của slug sau khi đã commit.
    emitSpaceRegistryChanged(updated.slug);
    return this.toRegistration(updated);
  }

  /**
   * Đổi trạng thái vòng đời của không gian + dòng lịch sử
   * `status_change` trong cùng transaction. Đổi sang chính trạng
   * thái hiện tại là thao tác rỗng: trả dòng hiện tại, không ghi
   * lịch sử (lịch sử chỉ ghi thay đổi thật). Quyết định "có phải
   * thao tác rỗng" và ảnh `before` đều lấy từ dòng đã đọc kèm khoá
   * bên trong transaction — cùng lý do với đường cập nhật: trạng
   * thái thật ngay trước lần ghi này mới là căn cứ đúng.
   */
  async changeStatus(actorId: string, id: string, dto: ChangeSpaceStatus): Promise<SpaceRegistration> {
    await this.assertPlatformManager(actorId);
    let changedSlug: string | undefined;
    const updated = await this.repo.transaction(async (tx) => {
      const existing = await this.repo.findSpaceByIdForUpdate(id, tx);
      if (!existing) {
        throw new NotFoundException({ message: `Space registration ${id} not found`, code: 'control_plane.space_not_found' });
      }
      if (existing.status === dto.status) return existing;
      const row = await this.repo.updateSpace(id, { status: dto.status }, tx);
      await this.repo.insertHistory(
        { spaceId: id, actorId, action: 'status_change', before: this.snapshot(existing), after: this.snapshot(row) },
        tx,
      );
      changedSlug = row.slug;
      return row;
    });
    // Chỉ phát sự kiện khi trạng thái thật sự đổi (đổi về chính
    // trạng thái hiện tại là thao tác rỗng — sổ không đổi, đệm định
    // tuyến không cần vô hiệu hoá).
    if (changedSlug) emitSpaceRegistryChanged(changedSlug);
    return this.toRegistration(updated);
  }

  /** Tra cứu định tuyến theo slug: trả nguyên dòng đăng ký của không gian. */
  async getBySlug(actorId: string, slug: string): Promise<SpaceRegistration> {
    await this.assertPlatformManager(actorId);
    const row = await this.repo.findSpaceBySlug(slug);
    if (!row) {
      throw new NotFoundException({ message: `Space slug ${slug} is not registered`, code: 'control_plane.space_not_found' });
    }
    return this.toRegistration(row);
  }

  /** Lịch sử quản trị của một không gian, mới nhất trước. */
  async listHistory(actorId: string, spaceId: string): Promise<SpaceRegistryHistoryEntry[]> {
    await this.assertPlatformManager(actorId);
    if (!(await this.repo.findSpaceById(spaceId))) {
      throw new NotFoundException({ message: `Space registration ${spaceId} not found`, code: 'control_plane.space_not_found' });
    }
    const rows = await this.repo.listHistory(spaceId);
    return rows.map((row) => ({
      id: row.id,
      spaceId: row.spaceId,
      actorId: row.actorId,
      action: row.action as SpaceRegistryHistoryEntry['action'],
      // Ảnh chụp trong jsonb do chính service này ghi theo hình dạng
      // hợp đồng (xem snapshot) — ép về kiểu hợp đồng ở biên đọc.
      before: row.before as SpaceRegistryHistoryEntry['before'],
      after: row.after as SpaceRegistryHistoryEntry['after'],
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Đọc trạng thái schema của một kho; kho chưa có dòng registry thì trả trạng thái rỗng (mọi trường null). */
  async getSchemaRegistry(actorId: string, spaceId: string): Promise<SpaceSchemaRegistry> {
    await this.assertPlatformManager(actorId);
    const space = await this.repo.findSpaceById(spaceId);
    if (!space) {
      throw new NotFoundException({ message: `Space registration ${spaceId} not found`, code: 'control_plane.space_not_found' });
    }
    const row = await this.repo.findSchemaRegistry(spaceId);
    return {
      spaceId,
      currentVersion: row?.currentVersion ?? null,
      lastBackupStatus: row?.lastBackupStatus ?? null,
      lastBackupAt: row?.lastBackupAt?.toISOString() ?? null,
      lastRestoreStatus: row?.lastRestoreStatus ?? null,
      lastRestoreAt: row?.lastRestoreAt?.toISOString() ?? null,
      updatedAt: (row?.updatedAt ?? space.updatedAt).toISOString(),
    };
  }

  /**
   * Ghi trạng thái schema của một kho (khung trường của issue này):
   * hợp nhất với trạng thái đã có rồi ghi đè một dòng; khi
   * `currentVersion` có mặt trong yêu cầu — kể cả giá trị `null`
   * (xoá phiên bản) — phiên bản trên dòng đăng ký cũng được đồng bộ
   * trong cùng transaction để hai nơi không lệch nhau; trường không
   * có mặt (`undefined`) mới là "không đụng".
   *
   * Việc hợp nhất đọc trạng thái hiện tại BÊN TRONG transaction,
   * sau khi khoá dòng đăng ký của không gian: khoá này nối tiếp mọi
   * thao tác ghi của không gian đó, nên hai lượt ghi đồng thời vào
   * các trường độc lập (ví dụ trạng thái sao lưu và trạng thái khôi
   * phục do hai tác vụ vận hành báo về) không còn cùng đọc một ảnh
   * cũ rồi ghi đè mất giá trị của nhau.
   */
  async updateSchemaRegistry(actorId: string, spaceId: string, dto: UpdateSpaceSchemaRegistry): Promise<SpaceSchemaRegistry> {
    await this.assertPlatformManager(actorId);
    const space = await this.repo.findSpaceById(spaceId);
    if (!space) {
      throw new NotFoundException({ message: `Space registration ${spaceId} not found`, code: 'control_plane.space_not_found' });
    }
    const row = await this.repo.transaction(async (tx) => {
      // Khoá dòng đăng ký trước (nối tiếp các thao tác ghi của
      // không gian), rồi mới đọc trạng thái schema hiện tại để hợp
      // nhất — thứ tự khoá thống nhất với các đường ghi khác.
      await this.repo.findSpaceByIdForUpdate(spaceId, tx);
      const existing = await this.repo.findSchemaRegistry(spaceId, tx);
      const merged = {
        spaceId,
        currentVersion: dto.currentVersion !== undefined ? dto.currentVersion : (existing?.currentVersion ?? null),
        lastBackupStatus: dto.lastBackupStatus !== undefined ? dto.lastBackupStatus : (existing?.lastBackupStatus ?? null),
        lastBackupAt:
          dto.lastBackupAt !== undefined ? (dto.lastBackupAt ? new Date(dto.lastBackupAt) : null) : (existing?.lastBackupAt ?? null),
        lastRestoreStatus: dto.lastRestoreStatus !== undefined ? dto.lastRestoreStatus : (existing?.lastRestoreStatus ?? null),
        lastRestoreAt:
          dto.lastRestoreAt !== undefined ? (dto.lastRestoreAt ? new Date(dto.lastRestoreAt) : null) : (existing?.lastRestoreAt ?? null),
      };
      const saved = await this.repo.upsertSchemaRegistry(merged, tx);
      if (dto.currentVersion !== undefined) {
        await this.repo.updateSpace(spaceId, { schemaVersion: dto.currentVersion }, tx);
      }
      return saved;
    });
    // Trạng thái/phiên bản của kho vừa đổi trên sổ: vô hiệu hoá đệm
    // định tuyến của slug sau khi đã commit.
    emitSpaceRegistryChanged(space.slug);
    return {
      spaceId: row.spaceId,
      currentVersion: row.currentVersion,
      lastBackupStatus: row.lastBackupStatus,
      lastBackupAt: row.lastBackupAt?.toISOString() ?? null,
      lastRestoreStatus: row.lastRestoreStatus,
      lastRestoreAt: row.lastRestoreAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Ghi một lượt chạy migration vào nhật ký của kho. Lượt `success`
   * có `toVersion` đồng thời nâng phiên bản hiện tại (registry phiên
   * bản schema + trường phiên bản trên dòng đăng ký) trong cùng
   * transaction — phiên bản hiện tại chỉ tiến khi lượt chạy thành
   * công, lượt hỏng không đổi phiên bản đích.
   *
   * Transaction khoá dòng đăng ký của không gian TRƯỚC khi đọc và
   * ghi đè registry phiên bản (issue #586, ghi chú từ phán quyết
   * PR #589): cùng thứ tự khoá với `updateSchemaRegistry`, nên một
   * lượt ghi migration và một lượt ghi trạng thái sao lưu/khôi phục
   * đồng thời của cùng không gian nối tiếp nhau thay vì cùng đọc một
   * ảnh cũ của registry rồi lần ghi sau ghi đè mất trường của lần
   * ghi trước (phiên bản mới bị thay bằng ảnh cũ, hoặc trạng thái
   * sao lưu vừa báo bị cuốn về giá trị trước đó).
   */
  async recordMigrationRun(actorId: string, spaceId: string, dto: RecordSpaceSchemaMigrationRun): Promise<SpaceSchemaMigrationRun> {
    await this.assertPlatformManager(actorId);
    const space = await this.repo.findSpaceById(spaceId);
    if (!space) {
      throw new NotFoundException({ message: `Space registration ${spaceId} not found`, code: 'control_plane.space_not_found' });
    }
    let versionChanged = false;
    const run = await this.repo.transaction(async (tx) => {
      // Khoá dòng đăng ký trước (nối tiếp các thao tác ghi của
      // không gian), rồi mới chèn lượt chạy và đọc trạng thái
      // registry để hợp nhất — thứ tự khoá thống nhất với
      // `updateSchemaRegistry`.
      await this.repo.findSpaceByIdForUpdate(spaceId, tx);
      const saved = await this.repo.insertMigrationRun(
        {
          spaceId,
          runId: dto.runId,
          fromVersion: dto.fromVersion ?? null,
          toVersion: dto.toVersion ?? null,
          status: dto.status,
          steps: dto.steps,
          finishedAt: dto.finishedAt ? new Date(dto.finishedAt) : dto.status === 'running' ? null : new Date(),
        },
        tx,
      );
      if (dto.status === 'success' && dto.toVersion) {
        versionChanged = true;
        const existing = await this.repo.findSchemaRegistry(spaceId, tx);
        await this.repo.upsertSchemaRegistry(
          {
            spaceId,
            currentVersion: dto.toVersion,
            lastBackupStatus: existing?.lastBackupStatus ?? null,
            lastBackupAt: existing?.lastBackupAt ?? null,
            lastRestoreStatus: existing?.lastRestoreStatus ?? null,
            lastRestoreAt: existing?.lastRestoreAt ?? null,
          },
          tx,
        );
        await this.repo.updateSpace(spaceId, { schemaVersion: dto.toVersion }, tx);
      }
      return saved;
    });
    // Lượt migration thành công đã nâng phiên bản trên dòng đăng
    // ký: vô hiệu hoá đệm định tuyến của slug sau khi đã commit.
    if (versionChanged) emitSpaceRegistryChanged(space.slug);
    return {
      id: run.id,
      spaceId: run.spaceId,
      runId: run.runId,
      fromVersion: run.fromVersion,
      toVersion: run.toVersion,
      status: run.status as SpaceSchemaMigrationRun['status'],
      steps: run.steps,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  /** Các lượt chạy migration đã ghi của một kho, cũ nhất trước. */
  async listMigrationRuns(actorId: string, spaceId: string): Promise<SpaceSchemaMigrationRun[]> {
    await this.assertPlatformManager(actorId);
    if (!(await this.repo.findSpaceById(spaceId))) {
      throw new NotFoundException({ message: `Space registration ${spaceId} not found`, code: 'control_plane.space_not_found' });
    }
    const rows = await this.repo.listMigrationRuns(spaceId);
    return rows.map((run) => ({
      id: run.id,
      spaceId: run.spaceId,
      runId: run.runId,
      fromVersion: run.fromVersion,
      toVersion: run.toVersion,
      status: run.status as SpaceSchemaMigrationRun['status'],
      steps: run.steps,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Gieo dữ kiện cho các không gian ĐÃ TỒN TẠI ở kho chung (đường
   * bootstrap/seed gọi): đảm bảo mỗi không gian có đúng một dòng
   * đăng ký ở chế độ `shared` + một dòng registry phiên bản schema
   * mang phiên bản của kho chung. Idempotent tuyệt đối — slug đã có
   * thì giữ nguyên dòng hiện tại (không ghi đè, không trùng), nên
   * chạy lại bao nhiêu lần cũng an toàn. Đây là ghi của HỆ THỐNG khi
   * khởi động, không phải thao tác quản trị, nên không qua cổng
   * capability và không ghi lịch sử quản trị.
   *
   * @returns số dòng đăng ký mới được tạo ở lượt này.
   */
  async seedExistingSpaces(spaces: ExistingSpaceSeed[]): Promise<number> {
    if (!this.isConfigured) return 0;
    let created = 0;
    for (const space of spaces) {
      const inserted = await this.repo.insertSpaceIfAbsent({
        slug: space.slug,
        name: space.name,
        kind: space.kind,
        status: 'active',
        databaseName: space.databaseName,
        storageMode: 'shared',
        connectionRoleRef: space.connectionRoleRef,
        secretRef: space.secretRef,
        schemaVersion: SHARED_DATABASE_SCHEMA_VERSION,
        plan: space.plan,
      });
      const row = inserted ?? (await this.repo.findSpaceBySlug(space.slug));
      if (!row) continue;
      if (inserted) created += 1;
      await this.repo.ensureSchemaRegistry(row.id, SHARED_DATABASE_SCHEMA_VERSION);
    }
    // Dòng đăng ký có thể vừa được tạo ở lượt gieo này: báo khung
    // định tuyến vô hiệu hoá đệm của các slug vừa gieo để lần phân
    // giải sau đọc đúng dòng hiện có trên sổ.
    for (const space of spaces) emitSpaceRegistryChanged(space.slug);
    if (created > 0) this.logger.log(`Seeded ${created} existing space registration(s) into the control plane registry`);
    return created;
  }
}
