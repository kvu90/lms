import {
  importBookDatasetSchema,
  type ImportBookDataset,
} from '@lms/contracts';

/**
 * Validation của Books dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  importBookDatasetSchema,
};
export type ImportBookDatasetDto = ImportBookDataset;
