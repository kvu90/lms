import {
  changePasswordSchema,
  loginAsSchema,
  loginSchema,
  mfaTotpCodeSchema,
  mfaTotpSetupSchema,
  mfaVerifySchema,
  oauthHandoffSchema,
  oauthIssuerSchema,
  refreshTokenSchema,
  type ChangePassword,
  type Login,
  type LoginAs,
  type MfaTotpCode,
  type MfaTotpSetup,
  type MfaVerify,
  type OAuthHandoff,
  type OAuthIssuer,
  type RefreshToken,
} from '@lms/contracts';

/**
 * Validation của Auth dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { changePasswordSchema, loginAsSchema, loginSchema, mfaTotpCodeSchema, mfaTotpSetupSchema, mfaVerifySchema, oauthHandoffSchema, oauthIssuerSchema, refreshTokenSchema };
export type LoginDto = Login;
export type RefreshDto = RefreshToken;
export type ChangePasswordDto = ChangePassword;
export type LoginAsDto = LoginAs;
export type MfaTotpCodeDto = MfaTotpCode;
export type MfaTotpSetupDto = MfaTotpSetup;
export type MfaVerifyDto = MfaVerify;
export type OAuthHandoffDto = OAuthHandoff;
export type OAuthIssuerParam = OAuthIssuer;
