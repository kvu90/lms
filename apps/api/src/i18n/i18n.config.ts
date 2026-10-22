import { join } from 'node:path';
import {
  AcceptLanguageLocaleResolver,
  CookieLocaleResolver,
  HeaderLocaleResolver,
  I18nModule,
  JsonI18nLoader,
  QueryLocaleResolver,
} from '@nestjs/i18n';

/**
 * Cấu hình i18n dùng chung (gói chính thức `@nestjs/i18n`, ghim exact 0.0.1 —
 * xem ADR tương ứng): catalog JSON tập trung tại `src/i18n/<locale>/*.json`,
 * locale mặc định là tiếng Việt, kèm tiếng Anh. Thứ tự resolver: query `lang`
 * → header `x-lang` → `Accept-Language` → cookie. `missingKey` ném lỗi ngoài
 * production để test phát hiện thiếu khoá sớm, production thì fallback về
 * locale mặc định.
 */
export const I18nFoundationModule = I18nModule.forRoot({
  defaultLocale: 'vi',
  supportedLocales: ['vi', 'en'],
  loader: new JsonI18nLoader({ path: join(__dirname, '..', 'i18n') }),
  resolvers: [
    new QueryLocaleResolver('lang'),
    new HeaderLocaleResolver('x-lang'),
    new AcceptLanguageLocaleResolver(),
    new CookieLocaleResolver('lang'),
  ],
  missingKey: process.env.NODE_ENV === 'production' ? 'fallback' : 'throw',
});
