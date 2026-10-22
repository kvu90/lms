import { z } from 'zod';

/** Identity & Access contracts — the single shape source between api and web. */

export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const loginResponseSchema = tokenPairSchema.extend({
  user: z.object({
    id: z.number().int(),
    username: z.string().min(1),
    forcePasswordChange: z.boolean(),
  }),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const customFieldValueSchema = z.object({
  shortname: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.string().nullable(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

/** Profile view: `email` is an identity field — absent unless the viewer holds moodle/site:viewuseridentity (or is the owner/admin). */
export const userProfileSchema = z.object({
  id: z.number().int(),
  username: z.string(),
  firstname: z.string(),
  lastname: z.string(),
  email: z.string().optional(),
  suspended: z.boolean(),
  deleted: z.boolean(),
  isGuest: z.boolean(),
  forcePasswordChange: z.boolean(),
  lastlogin: z.string().nullable(),
  timecreated: z.string(),
  customFields: z.array(customFieldValueSchema),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const userListResponseSchema = z.object({
  users: z.array(userProfileSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type UserListResponse = z.infer<typeof userListResponseSchema>;

export const roleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  shortname: z.string(),
  description: z.string(),
  archetype: z.string().nullable(),
});
export type Role = z.infer<typeof roleSchema>;

export const capabilitySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  captype: z.string(),
  contextlevel: z.number().int(),
  component: z.string(),
});
export type Capability = z.infer<typeof capabilitySchema>;

/** Moodle permission constants shared by the roles admin UI. */
export const CAP = { PROHIBIT: -1000, PREVENT: -1, INHERIT: 0, ALLOW: 1 } as const;
