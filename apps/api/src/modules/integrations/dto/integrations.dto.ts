import {
  callExternalFunctionSchema,
  createExternalServiceSchema,
  createExternalTokenSchema,
  setExternalServiceEnabledSchema,
  type CallExternalFunction,
  type CreateExternalService,
  type CreateExternalToken,
  type SetExternalServiceEnabled,
} from '@lms/contracts';

/**
 * Validation của Web Services dùng Zod qua Standard Schema:
 * schema nền ở `@lms/contracts` là nguồn sự thật duy nhất, dùng chung với form
 * phía React; server không định nghĩa hệ validation thứ hai.
 */
export { callExternalFunctionSchema, createExternalServiceSchema, createExternalTokenSchema, setExternalServiceEnabledSchema };
export type CreateServiceDto = CreateExternalService;
export type CreateTokenDto = CreateExternalToken;
export type CallFunctionDto = CallExternalFunction;
export type SetEnabledDto = SetExternalServiceEnabled;
