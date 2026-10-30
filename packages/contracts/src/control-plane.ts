import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của CONTROL PLANE (issue #580, chương trình tenant #579):
 * sổ đăng ký không gian (trung tâm / Trang chính) mà platform dùng để
 * biết mỗi không gian đang sống ở kho dữ liệu nào, cộng registry phiên
 * bản schema của từng kho đã đăng ký.
 *
 * Ranh giới nghiệp vụ của tầng này:
 * - Sổ chỉ giữ bản ghi định tuyến tối thiểu (định danh địa chỉ, kho
 *   đích, vòng đời, gói dịch vụ) — nhận diện riêng của trung tâm (logo,
 *   thương hiệu) thuộc về dữ liệu của chính trung tâm, không ở đây.
 * - `plan` chỉ là MÃ GÓI DỊCH VỤ được lưu lại; nghiệp vụ billing
 *   (hoá đơn, thu tiền) không thuộc hợp đồng này.
 * - Mọi trường bí mật chỉ là THAM CHIẾU (`secretRef`, ví dụ
 *   `env:CONTROL_PLANE_DATABASE_URL`) — giá trị bí mật không bao giờ
 *   đi qua API hay nằm trong database.
 * - Mọi thao tác ghi yêu cầu capability quản trị platform hiện hữu
 *   (`tenant:manage` tại context hệ thống) — tầng này không dựng mô
 *   hình tài khoản quản trị riêng.
 */
export const SPACE_KINDS = ['center', 'platform'] as const;
export const SPACE_STATUSES = ['provisioning', 'active', 'suspended', 'closed'] as const;
export const SPACE_STORAGE_MODES = ['shared', 'dedicated'] as const;
export const SPACE_SCHEMA_RUN_STATUSES = ['running', 'success', 'failed'] as const;

/** Mẫu slug của không gian — cùng khuôn slug tenant hiện hành (định danh địa chỉ, chữ thường + gạch nối). */
const spaceSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/);

export const spaceRegistrationSchema = z.object({
  id: uuidIdSchema,
  slug: z.string(),
  name: z.string(),
  kind: z.enum(SPACE_KINDS),
  status: z.enum(SPACE_STATUSES),
  databaseName: z.string(),
  storageMode: z.enum(SPACE_STORAGE_MODES),
  connectionRoleRef: z.string(),
  secretRef: z.string().nullable(),
  schemaVersion: z.string().nullable(),
  plan: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpaceRegistration = z.infer<typeof spaceRegistrationSchema>;

/** Tạo dòng đăng ký không gian — chỉ quản trị platform. Mặc định vòng đời bắt đầu ở `provisioning`. */
export const createSpaceRegistrationSchema = z.strictObject({
  slug: spaceSlugSchema,
  name: z.string().min(1).max(200),
  kind: z.enum(SPACE_KINDS),
  status: z.enum(SPACE_STATUSES).optional(),
  databaseName: z.string().min(1).max(120),
  storageMode: z.enum(SPACE_STORAGE_MODES),
  connectionRoleRef: z.string().min(1).max(200),
  secretRef: z.string().max(200).optional(),
  schemaVersion: z.string().max(120).optional(),
  plan: z.string().max(80).optional(),
});
export type CreateSpaceRegistration = z.infer<typeof createSpaceRegistrationSchema>;

/** Cập nhật dòng đăng ký: tên hiển thị trên sổ, kho đích, chế độ kho, tham chiếu kết nối/bí mật, phiên bản schema, gói. Slug và loại không gian là định danh — không sửa qua đường này. */
export const updateSpaceRegistrationSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  databaseName: z.string().min(1).max(120).optional(),
  storageMode: z.enum(SPACE_STORAGE_MODES).optional(),
  connectionRoleRef: z.string().min(1).max(200).optional(),
  secretRef: z.string().max(200).nullable().optional(),
  schemaVersion: z.string().max(120).nullable().optional(),
  plan: z.string().max(80).nullable().optional(),
});
export type UpdateSpaceRegistration = z.infer<typeof updateSpaceRegistrationSchema>;

/** Đổi trạng thái vòng đời của không gian — thao tác riêng để lịch sử quản trị ghi đúng loại hành động. */
export const changeSpaceStatusSchema = z.strictObject({
  status: z.enum(SPACE_STATUSES),
});
export type ChangeSpaceStatus = z.infer<typeof changeSpaceStatusSchema>;

/** Một dòng lịch sử quản trị của sổ: ai đã làm gì, giá trị trước/sau ra sao. */
export const spaceRegistryHistoryEntrySchema = z.object({
  id: uuidIdSchema,
  spaceId: uuidIdSchema,
  actorId: uuidIdSchema,
  action: z.enum(['create', 'update', 'status_change']),
  before: spaceRegistrationSchema.omit({ createdAt: true, updatedAt: true }).nullable(),
  after: spaceRegistrationSchema.omit({ createdAt: true, updatedAt: true }),
  createdAt: z.string(),
});
export type SpaceRegistryHistoryEntry = z.infer<typeof spaceRegistryHistoryEntrySchema>;

/** Trạng thái schema của một kho đã đăng ký: phiên bản hiện tại + khung trạng thái sao lưu/khôi phục gần nhất. */
export const spaceSchemaRegistrySchema = z.object({
  spaceId: uuidIdSchema,
  currentVersion: z.string().nullable(),
  lastBackupStatus: z.string().nullable(),
  lastBackupAt: z.string().nullable(),
  lastRestoreStatus: z.string().nullable(),
  lastRestoreAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type SpaceSchemaRegistry = z.infer<typeof spaceSchemaRegistrySchema>;

/**
 * Ghi trạng thái schema của một kho (khung trường): phiên bản hiện tại
 * và trạng thái sao lưu/khôi phục. Cơ chế tự động ghi bởi công cụ
 * fleet thuộc issue #586; ở đây dữ kiện được ghi qua API quản trị.
 * Mốc thời gian dùng `z.iso.datetime` theo chuẩn hợp đồng của repo.
 */
export const updateSpaceSchemaRegistrySchema = z.strictObject({
  currentVersion: z.string().max(120).nullable().optional(),
  lastBackupStatus: z.string().max(40).nullable().optional(),
  lastBackupAt: z.iso.datetime({ offset: true }).nullable().optional(),
  lastRestoreStatus: z.string().max(40).nullable().optional(),
  lastRestoreAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type UpdateSpaceSchemaRegistry = z.infer<typeof updateSpaceSchemaRegistrySchema>;

/** Kết quả một bước của một lượt chạy migration — khung tối thiểu, công cụ ghi lượt (issue #586) được thêm trường riêng. */
export const spaceSchemaMigrationStepSchema = z.looseObject({
  name: z.string(),
  status: z.string(),
  detail: z.string().optional(),
});

/** Ghi một lượt chạy migration trên kho của một không gian. Lượt `success` có `toVersion` sẽ nâng phiên bản hiện tại của kho lên `toVersion`. */
export const recordSpaceSchemaMigrationRunSchema = z.strictObject({
  runId: z.string().min(1).max(120),
  fromVersion: z.string().max(120).nullable().optional(),
  toVersion: z.string().max(120).nullable().optional(),
  status: z.enum(SPACE_SCHEMA_RUN_STATUSES),
  steps: z.array(spaceSchemaMigrationStepSchema).default([]),
  finishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type RecordSpaceSchemaMigrationRun = z.infer<typeof recordSpaceSchemaMigrationRunSchema>;

export const spaceSchemaMigrationRunSchema = z.object({
  id: uuidIdSchema,
  spaceId: uuidIdSchema,
  runId: z.string(),
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  status: z.enum(SPACE_SCHEMA_RUN_STATUSES),
  steps: z.array(spaceSchemaMigrationStepSchema),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type SpaceSchemaMigrationRun = z.infer<typeof spaceSchemaMigrationRunSchema>;
