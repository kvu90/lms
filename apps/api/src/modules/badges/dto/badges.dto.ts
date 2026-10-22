import {
  badgeUserSchema,
  createBadgeSchema,
  setBadgeCriteriaSchema,
  setBadgeStatusSchema,
  updateBadgeSchema,
  type BadgeUser,
  type CreateBadge,
  type SetBadgeCriteria,
  type SetBadgeStatus,
  type UpdateBadge,
} from '@lms/contracts';

/**
 * Validation của Badges dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { badgeUserSchema, createBadgeSchema, setBadgeCriteriaSchema, setBadgeStatusSchema, updateBadgeSchema };
export type CreateBadgeDto = CreateBadge;
export type UpdateBadgeDto = UpdateBadge;
export type SetStatusDto = SetBadgeStatus;
export type SetCriteriaDto = SetBadgeCriteria;
export type ManualAwardDto = BadgeUser;
export type EvaluateDto = BadgeUser;
