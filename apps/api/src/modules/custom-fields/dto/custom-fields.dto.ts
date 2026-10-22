import {
  createCustomFieldCategorySchema,
  createCustomFieldSchema,
  type CreateCustomField,
  type CreateCustomFieldCategory,
} from '@lms/contracts';

/**
 * Validation của Custom Fields dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { createCustomFieldCategorySchema, createCustomFieldSchema };
export type CreateCategoryDto = CreateCustomFieldCategory;
export type CreateFieldDto = CreateCustomField;
