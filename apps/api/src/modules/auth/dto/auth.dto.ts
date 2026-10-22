import {
  changePasswordSchema,
  loginAsSchema,
  loginSchema,
  mfaTotpCodeSchema,
  mfaVerifySchema,
  refreshTokenSchema,
  type ChangePassword,
  type Login,
  type LoginAs,
  type MfaTotpCode,
  type MfaVerify,
  type RefreshToken,
} from '@lms/contracts';

/**
 * Validation của Auth dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { changePasswordSchema, loginAsSchema, loginSchema, mfaTotpCodeSchema, mfaVerifySchema, refreshTokenSchema };
export type LoginDto = Login;
export type RefreshDto = RefreshToken;
export type ChangePasswordDto = ChangePassword;
export type LoginAsDto = LoginAs;
export type MfaTotpCodeDto = MfaTotpCode;
export type MfaVerifyDto = MfaVerify;
