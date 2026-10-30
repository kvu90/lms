import {
  changeSpaceStatusSchema,
  createSpaceRegistrationSchema,
  recordSpaceSchemaMigrationRunSchema,
  updateSpaceRegistrationSchema,
  updateSpaceSchemaRegistrySchema,
  type ChangeSpaceStatus,
  type CreateSpaceRegistration,
  type RecordSpaceSchemaMigrationRun,
  type UpdateSpaceRegistration,
  type UpdateSpaceSchemaRegistry,
} from '@lms/contracts';

/**
 * Validation của module Control Plane dùng Zod qua Standard Schema —
 * schema nền ở `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  changeSpaceStatusSchema,
  createSpaceRegistrationSchema,
  recordSpaceSchemaMigrationRunSchema,
  updateSpaceRegistrationSchema,
  updateSpaceSchemaRegistrySchema,
};
export type CreateSpaceRegistrationDto = CreateSpaceRegistration;
export type UpdateSpaceRegistrationDto = UpdateSpaceRegistration;
export type ChangeSpaceStatusDto = ChangeSpaceStatus;
export type UpdateSpaceSchemaRegistryDto = UpdateSpaceSchemaRegistry;
export type RecordSpaceSchemaMigrationRunDto = RecordSpaceSchemaMigrationRun;
