import { join } from 'node:path';
import { I18nModule, JsonI18nLoader } from '@nestjs/i18n';

/**
 * Cấu hình i18n cho worker (cùng gói chính thức `@nestjs/i18n` và cùng bộ
 * khoá với API): worker chạy ngoài request context nên không dùng resolver —
 * processor truyền `locale` tường minh (ngôn ngữ đã lưu của người nhận, mặc
 * định 'vi') vào `I18nService.t()`. Catalog tại `src/i18n/<locale>/*.json`.
 */
export const I18nWorkerModule = I18nModule.forRoot({
  defaultLocale: 'vi',
  supportedLocales: ['vi', 'en'],
  loader: new JsonI18nLoader({ path: join(__dirname, '..', 'i18n') }),
  resolvers: [],
  missingKey: process.env.NODE_ENV === 'production' ? 'fallback' : 'throw',
});
