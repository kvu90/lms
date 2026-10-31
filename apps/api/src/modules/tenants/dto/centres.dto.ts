import {
  activateCentreInviteSchema,
  centreIdentitySchema,
  updateCentreIdentitySchema,
  type ActivateCentreInvite,
  type CentreIdentity,
  type UpdateCentreIdentity,
} from '@lms/contracts';

/**
 * Validation của bề mặt trung tâm dùng Zod qua Standard Schema —
 * schema nền ở `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { activateCentreInviteSchema, centreIdentitySchema, updateCentreIdentitySchema };
export type CentreIdentityDto = CentreIdentity;
export type UpdateCentreIdentityDto = UpdateCentreIdentity;
export type ActivateCentreInviteDto = ActivateCentreInvite;
