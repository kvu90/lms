import { createGuardianLinkSchema, type CreateGuardianLink, guardianDigestPreferenceSchema, type GuardianDigestPreferenceInput } from '@lms/contracts';

/**
 * Validation của Guardians dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (tiền lệ grades.dto).
 */
export { createGuardianLinkSchema };
export type CreateGuardianLinkDto = CreateGuardianLink;

/** Tuỳ chọn digest PH-2 (issue #159): schema nền ở contracts như trên. */
export { guardianDigestPreferenceSchema };
export type GuardianDigestPreferenceDto = GuardianDigestPreferenceInput;
