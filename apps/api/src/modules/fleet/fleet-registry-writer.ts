/**
 * Cầu ghi registry cho các công cụ vận hành đội kho (issue #586):
 * các script CLI (`fleet-migration-runner.ts`, `fleet-backup.ts`,
 * `fleet-restore-test.ts`) chạy NGOÀI vòng đời NestJS của ứng dụng,
 * nên file này tự lắp `ControlPlaneConnection` +
 * `ControlPlaneRepository` của module control plane với một
 * `ConfigService` tối giản đọc thẳng `process.env` — dùng lại đúng
 * repository và đúng bất biến ghi của tầng service, không dựng
 * đường ghi song song.
 *
 * Mọi thao tác ghi ở đây tuân theo cùng một khuôn khoá như
 * `ControlPlaneRegistryService` (sau bản sửa của issue này): mở
 * transaction → khoá dòng đăng ký của không gian (`FOR UPDATE`) →
 * đọc registry hiện tại → hợp nhất các trường mình phụ trách, giữ
 * nguyên các trường của tác vụ khác → ghi. Nhờ vậy runner
 * migration, tác vụ sao lưu và tác vụ kiểm thử khôi phục chạy đồng
 * thời trên cùng một kho không ghi đè mất trạng thái của nhau.
 *
 * Khác với service: không có gác capability ở đây — các script là
 * công cụ vận hành chạy bằng thông tin đăng nhập của chính đội vận
 * hành trên máy triển khai; quyền truy cập script và biến môi
 * trường của chúng là ranh giới tin cậy của tầng vận hành.
 */
import type { ConfigService } from '@nestjs/config';
import type { SchemaMigrationStep } from '@lms/db/control-plane';
import type { SpaceRegistryRow } from '@lms/db/repositories/control-plane';
import type { FleetSpace } from './fleet-common';
import { ControlPlaneRepository } from '@lms/db/repositories/control-plane';
import { ControlPlaneConnection } from '../control-plane/control-plane.connection';

/** Kết quả một lượt chạy migration mà runner báo về registry. */
export type MigrationRunOutcome = {
  runId: string;
  fromVersion: string | null;
  toVersion: string | null;
  status: 'success' | 'failed';
  steps: SchemaMigrationStep[];
};

/**
 * Bộ ghi/đọc registry của đội kho trên một kết nối control plane.
 * @throws Error khi `CONTROL_PLANE_DATABASE_URL` chưa được cấu hình
 * — công cụ vận hành không có registry để ghi thì phải dừng rõ
 * ràng, khác với ứng dụng (vẫn khởi động khi chưa cấu hình).
 */
export class FleetRegistryWriter {
  private readonly connection: ControlPlaneConnection;
  private readonly repo: ControlPlaneRepository;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const stub = {
      get: (key: string) => (key === 'DATABASE_SSL' ? env[key] === 'true' : env[key]),
    } as unknown as ConfigService;
    this.connection = new ControlPlaneConnection(stub);
    if (!this.connection.isConfigured) {
      throw new Error('CONTROL_PLANE_DATABASE_URL is required for fleet operations tooling');
    }
    // Adapter đã xác nhận có handle (isConfigured): repository của
    // package nhận thẳng handle Kysely của adapter.
    this.repo = new ControlPlaneRepository(this.connection.kysely);
  }

  /** Toàn bộ sổ đăng ký kèm ảnh registry phiên bản/trạng thái của từng kho, theo thứ tự slug. */
  async listFleetSpaces(): Promise<FleetSpace[]> {
    const spaces = await this.repo.listSpaces();
    const fleet: FleetSpace[] = [];
    for (const space of spaces) {
      const registry = await this.repo.findSchemaRegistry(space.id);
      fleet.push({
        id: space.id,
        slug: space.slug,
        kind: space.kind === 'platform' ? 'platform' : 'center',
        status: space.status,
        databaseName: space.databaseName,
        secretRef: space.secretRef,
        registryVersion: registry?.currentVersion ?? space.schemaVersion,
        lastBackupAt: registry?.lastBackupAt ?? null,
        lastRestoreAt: registry?.lastRestoreAt ?? null,
      });
    }
    return fleet;
  }

  /** Tra cứu dòng đăng ký theo slug (đường kiểm tra chạy lại của pipeline cấp phát). */
  async findSpaceBySlug(slug: string): Promise<SpaceRegistryRow | undefined> {
    return this.repo.findSpaceBySlug(slug);
  }

  /** Tra cứu dòng đăng ký theo tên database đích (đường kiểm tra trùng của pipeline cấp phát). */
  async findSpaceByDatabaseName(databaseName: string): Promise<SpaceRegistryRow | undefined> {
    return this.repo.findSpaceByDatabaseName(databaseName);
  }

  /**
   * Tạo dòng đăng ký cho một trung tâm mới (bước 1 của pipeline cấp
   * phát, issue #583) + dòng lịch sử `create` trong cùng transaction
   * — cùng bất biến "sổ + lịch sử cùng thành/bại" với
   * `ControlPlaneRegistryService.createRegistration` nhưng không qua
   * gác capability của tầng HTTP (ranh giới tin cậy là quyền chạy
   * script của đội vận hành). Trả về dòng vừa tạo, hoặc undefined
   * khi slug đã tồn tại — người gọi quyết định tiếp tục (chạy lại)
   * hay báo xung đột, writer không tự đoán.
   */
  async createSpaceRegistration(
    actorId: string,
    values: {
      slug: string;
      name: string;
      kind: 'center' | 'platform';
      databaseName: string;
      connectionRoleRef: string;
      secretRef: string;
      plan: string | null;
    },
  ): Promise<SpaceRegistryRow | undefined> {
    return this.repo.transaction(async (tx) => {
      const row = await this.repo.insertSpaceIfAbsent(
        {
          slug: values.slug,
          name: values.name,
          kind: values.kind,
          status: 'provisioning',
          databaseName: values.databaseName,
          storageMode: 'dedicated',
          connectionRoleRef: values.connectionRoleRef,
          secretRef: values.secretRef,
          schemaVersion: null,
          plan: values.plan,
        },
        tx,
      );
      if (!row) return undefined;
      await this.repo.insertHistory({ spaceId: row.id, actorId, action: 'create', before: null, after: snapshotOf(row) }, tx);
      return row;
    });
  }

  /**
   * Đổi trạng thái vòng đời của một dòng đăng ký (bước kích hoạt của
   * pipeline cấp phát và thao tác tạm ngưng/mở lại, issue #583) +
   * dòng lịch sử `status_change` trong cùng transaction, khoá dòng
   * trước khi đọc ảnh `before` — cùng khuôn với
   * `ControlPlaneRegistryService.changeStatus`. Trạng thái đích
   * trùng trạng thái hiện tại thì không ghi gì (không tạo lịch sử
   * rỗng), trả về dòng hiện tại.
   */
  async changeSpaceStatus(
    spaceId: string,
    status: 'provisioning' | 'active' | 'suspended' | 'closed',
    actorId: string,
  ): Promise<SpaceRegistryRow> {
    return this.repo.transaction(async (tx) => {
      const existing = await this.repo.findSpaceByIdForUpdate(spaceId, tx);
      if (!existing) throw new Error(`Space registration ${spaceId} not found`);
      if (existing.status === status) return existing;
      const row = await this.repo.updateSpace(spaceId, { status }, tx);
      await this.repo.insertHistory(
        { spaceId, actorId, action: 'status_change', before: snapshotOf(existing), after: snapshotOf(row) },
        tx,
      );
      return row;
    });
  }

  /**
   * Ghi kết quả một lượt chạy migration: chèn dòng nhật ký lượt
   * chạy; khi lượt thành công và có phiên bản đích thì đồng thời
   * nâng phiên bản hiện tại ở cả registry lẫn dòng đăng ký — cùng
   * bất biến và cùng thứ tự khoá với
   * `ControlPlaneRegistryService.recordMigrationRun` nhưng không
   * qua gác capability của tầng HTTP.
   */
  async recordMigrationOutcome(spaceId: string, outcome: MigrationRunOutcome): Promise<void> {
    await this.repo.transaction(async (tx) => {
      await this.repo.findSpaceByIdForUpdate(spaceId, tx);
      await this.repo.insertMigrationRun(
        {
          spaceId,
          runId: outcome.runId,
          fromVersion: outcome.fromVersion,
          toVersion: outcome.toVersion,
          status: outcome.status,
          steps: outcome.steps,
          finishedAt: new Date(),
        },
        tx,
      );
      if (outcome.status === 'success' && outcome.toVersion) {
        const existing = await this.repo.findSchemaRegistry(spaceId, tx);
        await this.repo.upsertSchemaRegistry(
          {
            spaceId,
            currentVersion: outcome.toVersion,
            lastBackupStatus: existing?.lastBackupStatus ?? null,
            lastBackupAt: existing?.lastBackupAt ?? null,
            lastRestoreStatus: existing?.lastRestoreStatus ?? null,
            lastRestoreAt: existing?.lastRestoreAt ?? null,
          },
          tx,
        );
        await this.repo.updateSpace(spaceId, { schemaVersion: outcome.toVersion }, tx);
      }
    });
  }

  /**
   * Đồng bộ phiên bản trên sổ về đúng sự thật đọc được trong
   * database của kho mà KHÔNG bịa một dòng nhật ký lượt chạy: dùng
   * khi runner phát hiện kho đã ở phiên bản đích nhưng sổ còn ghi
   * phiên bản cũ (lệch sổ sau một lượt ghi dở dang) — sự thật trong
   * database thắng, sổ được sửa cho khớp.
   */
  async syncVersion(spaceId: string, version: string | null): Promise<void> {
    await this.repo.transaction(async (tx) => {
      await this.repo.findSpaceByIdForUpdate(spaceId, tx);
      const existing = await this.repo.findSchemaRegistry(spaceId, tx);
      await this.repo.upsertSchemaRegistry(
        {
          spaceId,
          currentVersion: version,
          lastBackupStatus: existing?.lastBackupStatus ?? null,
          lastBackupAt: existing?.lastBackupAt ?? null,
          lastRestoreStatus: existing?.lastRestoreStatus ?? null,
          lastRestoreAt: existing?.lastRestoreAt ?? null,
        },
        tx,
      );
      await this.repo.updateSpace(spaceId, { schemaVersion: version }, tx);
    });
  }

  /**
   * Ghi kết quả lượt sao lưu gần nhất của một kho, giữ nguyên mọi
   * trường còn lại của registry. Trạng thái gần nhất LUÔN được ghi
   * (để đọc được lượt vừa rồi thành hay bại), nhưng mốc
   * `lastBackupAt` CHỈ tiến khi lượt thành công: mốc này là căn cứ
   * duy nhất của cổng kiểm quá hạn (`checkFleetBackups`), nên một
   * lượt hỏng mà cũng đẩy mốc thì kho hỏng triền miên sẽ trông như
   * vừa sao lưu xong và cổng kiểm im lặng — báo xanh giả. Kho chưa
   * từng thành công giữ mốc null và bị cổng kiểm liệt kê quá hạn
   * đúng như sự thật của nó.
   */
  async recordBackupOutcome(spaceId: string, status: 'success' | 'failed', at: Date): Promise<void> {
    if (status === 'success') {
      await this.mergeRegistry(spaceId, { lastBackupStatus: status, lastBackupAt: at });
      return;
    }
    await this.mergeRegistry(spaceId, { lastBackupStatus: status });
  }

  /** Ghi kết quả lượt kiểm thử khôi phục gần nhất của một kho, giữ nguyên mọi trường còn lại của registry. */
  async recordRestoreOutcome(spaceId: string, status: 'success' | 'failed', at: Date): Promise<void> {
    await this.mergeRegistry(spaceId, { lastRestoreStatus: status, lastRestoreAt: at });
  }

  /**
   * Khuôn hợp nhất dùng chung: khoá dòng đăng ký, đọc registry hiện
   * tại, ghi lại toàn bộ ảnh với đúng các trường được truyền vào là
   * thay đổi. Phiên bản hiện tại khi chưa có dòng registry thì lấy
   * từ chính dòng đăng ký (ảnh phản chiếu đang có hiệu lực).
   */
  private async mergeRegistry(
    spaceId: string,
    patch: Partial<{
      lastBackupStatus: string;
      lastBackupAt: Date;
      lastRestoreStatus: string;
      lastRestoreAt: Date;
    }>,
  ): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const space = await this.repo.findSpaceByIdForUpdate(spaceId, tx);
      const existing = await this.repo.findSchemaRegistry(spaceId, tx);
      await this.repo.upsertSchemaRegistry(
        {
          spaceId,
          currentVersion: existing?.currentVersion ?? space?.schemaVersion ?? null,
          lastBackupStatus: patch.lastBackupStatus ?? existing?.lastBackupStatus ?? null,
          lastBackupAt: patch.lastBackupAt ?? existing?.lastBackupAt ?? null,
          lastRestoreStatus: patch.lastRestoreStatus ?? existing?.lastRestoreStatus ?? null,
          lastRestoreAt: patch.lastRestoreAt ?? existing?.lastRestoreAt ?? null,
        },
        tx,
      );
    });
  }

  /**
   * Ghi/ghi đè một mục THƯ MỤC THÀNH VIÊN (issue #587, hạng mục
   * 3 — thiết kế B1) cho các đường ghi ngoài vòng đời NestJS:
   * pipeline cấp phát dùng điểm này để ghi mục của quản trị đầu
   * tiên ngay khi membership của họ được tạo trong kho trung
   * tâm, cùng bất biến upsert theo cặp (người dùng, không gian)
   * với điểm ghi của tầng service.
   *
   * @param values - Cặp định danh (toàn cục / tại kho đích),
   *   slug không gian và trạng thái membership của mục.
   */
  async upsertMembershipDirectoryEntry(values: {
    globalUserId: string;
    spaceSlug: string;
    spaceUserId: string;
    status: string;
  }): Promise<void> {
    await this.repo.upsertMembershipDirectory(values);
  }

  /**
   * Tra một mục THƯ MỤC MÃ THAM GIA theo mã (issue #587, hạng
   * mục 3 — thiết kế C1) cho các đường vận hành ngoài vòng đời
   * NestJS: công cụ lấp thư mục dùng để phân biệt "mã đã thuộc
   * về chính không gian" với "mã đang thuộc về không gian khác"
   * (va chạm phải báo cáo, cấm ghi đè).
   */
  async findJoinCodeDirectoryEntry(joinCode: string): Promise<{ joinCode: string; spaceSlug: string } | undefined> {
    return this.repo.findJoinCodeDirectory(joinCode);
  }

  /**
   * Đăng ký một mã tham gia vào thư mục cho một không gian
   * (issue #587, hạng mục 3 — thiết kế C1) cho các đường vận
   * hành ngoài vòng đời NestJS — cùng ngữ nghĩa ba trạng thái
   * với `ControlPlaneRepository.claimJoinCodeDirectory`.
   */
  async claimJoinCodeDirectoryEntry(joinCode: string, spaceSlug: string): Promise<'claimed' | 'already' | 'conflict'> {
    return this.repo.claimJoinCodeDirectory(joinCode, spaceSlug);
  }

  /** Đóng pool kết nối control plane của bộ ghi. */
  async close(): Promise<void> {
    await this.connection.onModuleDestroy();
  }
}

/**
 * Ảnh chụp một dòng đăng ký để ghi lịch sử — cùng hình dạng với
 * `ControlPlaneRegistryService.snapshot` (id, slug, name, kind,
 * status, databaseName, storageMode, connectionRoleRef, secretRef,
 * schemaVersion, plan), không kèm mốc thời gian.
 */
function snapshotOf(row: SpaceRegistryRow): {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: string;
  databaseName: string;
  storageMode: string;
  connectionRoleRef: string;
  secretRef: string | null;
  schemaVersion: string | null;
  plan: string | null;
} {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    status: row.status,
    databaseName: row.databaseName,
    storageMode: row.storageMode,
    connectionRoleRef: row.connectionRoleRef,
    secretRef: row.secretRef,
    schemaVersion: row.schemaVersion,
    plan: row.plan,
  };
}
