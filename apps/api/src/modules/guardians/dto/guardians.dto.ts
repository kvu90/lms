import { createGuardianLinkSchema, type CreateGuardianLink } from '@lms/contracts';

/**
 * Validation của Guardians dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (tiền lệ grades.dto).
 */
export { createGuardianLinkSchema };
export type CreateGuardianLinkDto = CreateGuardianLink;
