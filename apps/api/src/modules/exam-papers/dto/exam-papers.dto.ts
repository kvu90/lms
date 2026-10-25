/**
 * DTO của lớp Ngân hàng đề (EB-1): hợp đồng dùng chung một nguồn sự
 * thật ở `@lms/contracts` (schema Zod) — file này chỉ đặt tên kiểu cho
 * controller/service dùng thống nhất với các module khác.
 */
export {
  createExamPaperSchema, updateExamPaperSchema, setExamPaperSlotsSchema,
  setExamPaperStatusSchema, copyExamPaperSchema, createExamPaperContributionSchema,
  approveExamPaperContributionSchema, rejectExamPaperContributionSchema, deployExamPaperSchema,
  materializeExamPaperSchema, swapExamPaperSlotSchema,
  createExamDossierSchema, approveExamDossierSchema, rejectExamDossierSchema,
  type CreateExamPaper as CreateExamPaperDto,
  type UpdateExamPaper as UpdateExamPaperDto,
  type SetExamPaperSlots as SetExamPaperSlotsDto,
  type SetExamPaperStatus as SetExamPaperStatusDto,
  type CopyExamPaper as CopyExamPaperDto,
  type CreateExamPaperContribution as CreateExamPaperContributionDto,
  type ApproveExamPaperContribution as ApproveExamPaperContributionDto,
  type RejectExamPaperContribution as RejectExamPaperContributionDto,
  type DeployExamPaper as DeployExamPaperDto,
  type MaterializeExamPaper as MaterializeExamPaperDto,
  type SwapExamPaperSlot as SwapExamPaperSlotDto,
  type CreateExamDossier as CreateExamDossierDto,
  type ApproveExamDossier as ApproveExamDossierDto,
  type RejectExamDossier as RejectExamDossierDto,
} from '@lms/contracts';
