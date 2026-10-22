import { z } from 'zod';

/**
 * Hợp đồng API của Site Config (cấu hình site + cấu hình theo plugin):
 * giá trị ghi đè do quản trị lưu xuống cơ sở dữ liệu; kiểu và miền giá trị
 * của từng setting do registry phía máy chủ quyết định, ở đây chỉ chốt
 * hình dạng vận chuyển (giá trị là JSON bất kỳ, máy chủ kiểm chứng sau).
 */
export const setSiteSettingSchema = z.strictObject({
  value: z.unknown(),
});

export type SetSiteSetting = z.infer<typeof setSiteSettingSchema>;

/** Một setting hiệu lực như API trả về: giá trị mặc định trong code hoặc giá trị đã ghi đè trong cơ sở dữ liệu. */
export const siteSettingSchema = z.object({
  component: z.string(),
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  defaultValue: z.unknown(),
  value: z.unknown(),
  source: z.enum(['default', 'database']),
});

export type SiteSetting = z.infer<typeof siteSettingSchema>;

/** Một dòng vết thay đổi cấu hình (ai đổi, từ giá trị nào sang giá trị nào). */
export const siteSettingAuditEntrySchema = z.object({
  id: z.string(),
  settingKey: z.string(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  changedBy: z.string().nullable(),
  createdAt: z.string(),
});

export type SiteSettingAuditEntry = z.infer<typeof siteSettingAuditEntrySchema>;
