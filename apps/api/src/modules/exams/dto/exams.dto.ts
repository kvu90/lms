/**
 * DTO của lớp Ngân hàng đề (EB-1): hợp đồng dùng chung một nguồn sự
 * thật ở `@lms/contracts` (schema Zod) — file này chỉ đặt tên kiểu cho
 * controller/service dùng thống nhất với các module khác.
 */
export {
  createExamSchema, updateExamSchema, setExamSlotsSchema,
  setExamStatusSchema, copyExamSchema, createExamContributionSchema,
  approveExamContributionSchema, rejectExamContributionSchema,
  withdrawExamSchema,
  swapExamSlotSchema,
  createExamDossierSchema, approveExamDossierSchema, rejectExamDossierSchema,
  type CreateExam as CreateExamDto,
  type UpdateExam as UpdateExamDto,
  type SetExamSlots as SetExamSlotsDto,
  type SetExamStatus as SetExamStatusDto,
  type CopyExam as CopyExamDto,
  type CreateExamContribution as CreateExamContributionDto,
  type ApproveExamContribution as ApproveExamContributionDto,
  type RejectExamContribution as RejectExamContributionDto,
  type WithdrawExam as WithdrawExamDto,
  type SwapExamSlot as SwapExamSlotDto,
  type CreateExamDossier as CreateExamDossierDto,
  type ApproveExamDossier as ApproveExamDossierDto,
  type RejectExamDossier as RejectExamDossierDto,
} from '@lms/contracts';
