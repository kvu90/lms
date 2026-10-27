import { describe, expect, it } from 'vitest';
import { RouteErrorBoundary } from '../components/route-error-boundary';
import i18n from '../i18n';
import * as backupRoute from './backup';
import * as insightsRoute from './insights';
import * as privacyRoute from './privacy';
import * as reportsRoute from './reports';
import * as searchRoute from './search';
import * as tokensRoute from './tokens';

/**
 * Spec gác F-07/F-08 (rà soát #133) cho 6 route module platform
 * (search / tokens / backup / insights / reports / privacy) bằng
 * CHÍNH các route module thật — bổ sung cho lát hoàn tất #133-A
 * theo điều kiện review: trước spec này, ca F-07 trong
 * `ssr-frame.spec.tsx` chỉ khẳng định CƠ CHẾ biên lỗi bằng route
 * tổng hợp tự chế và không spec nào gọi `meta()` của route thật,
 * nên một khoá tiêu đề gõ sai trong 6 file này vẫn qua được
 * typecheck (helper `platformKeyMeta` nhận chuỗi tự do) và chỉ lộ
 * khi rà tay.
 *
 * Với từng route module, spec khẳng định hai điểm của nghiệm thu
 * lát #133-A:
 *  1. Export `ErrorBoundary` là ĐÚNG component dùng chung
 *     `RouteErrorBoundary` (so sánh đồng nhất tham chiếu, không
 *     phải một component trông giống) — lỗi của trang được chứa
 *     trong vùng nội dung theo cơ chế đã gác ở `ssr-frame.spec.tsx`.
 *  2. `meta()` trả tiêu đề "<Tên trang> · LMS" dựng từ ĐÚNG khoá
 *     tiêu đề mà chính trang dùng cho heading của nó trong
 *     namespace `platform` (searchTitle / tokensTitle / backupTitle
 *     / insightsTitle / reportsTitle / privacyTitle). Khoá phải tồn
 *     tại thật trong resources: nếu khoá sai hoặc thiếu, `i18n.t`
 *     trả lại chính chuỗi khoá và ca đối chiếu khoá-suy-ra sẽ đỏ
 *     thay vì xanh giả.
 */
const CASES = [
  { name: 'search', route: searchRoute, key: 'searchTitle' },
  { name: 'tokens', route: tokensRoute, key: 'tokensTitle' },
  { name: 'backup', route: backupRoute, key: 'backupTitle' },
  { name: 'insights', route: insightsRoute, key: 'insightsTitle' },
  { name: 'reports', route: reportsRoute, key: 'reportsTitle' },
  { name: 'privacy', route: privacyRoute, key: 'privacyTitle' },
] as const;

describe('F-07/F-08 (#133): 6 route module platform thật — ErrorBoundary dùng chung + meta() theo trang', () => {
  for (const { name, route, key } of CASES) {
    it(`route ${name} exports the shared RouteErrorBoundary as its ErrorBoundary`, () => {
      expect(route.ErrorBoundary).toBe(RouteErrorBoundary);
    });

    it(`route ${name} meta() returns the title built from its own platform key ${key}`, () => {
      const expectedTitle = i18n.t(key, { ns: 'platform' });
      expect(expectedTitle).not.toBe(key);
      expect(route.meta()).toEqual([{ title: `${expectedTitle} · LMS` }]);
    });
  }
});
