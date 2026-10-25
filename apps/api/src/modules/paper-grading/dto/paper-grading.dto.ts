/**
 * DTO của chấm bài giấy (CAM-0, issue #112): dùng thẳng schema của
 * `@lms/contracts` (một nguồn sự thật cho cả API lẫn web) — file này
 * chỉ đặt tên cục bộ cho controller.
 */
export {
  assignPaperBatchSchema,
  assignPaperIdentitySchema,
  createPaperBatchSchema,
  resolvePaperReadingsSchema,
  type AssignPaperBatch,
  type AssignPaperIdentity,
  type CreatePaperBatch,
  type ResolvePaperReadings,
} from '@lms/contracts';
