import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_PROVIDERS, providerByName } from './notification-providers';

/**
 * Parity luật thông báo API ↔ worker — nửa ĐỐI CHIẾU TRƯỜNG LUẬT
 * (issue #293).
 *
 * Bối cảnh: registry `MESSAGE_PROVIDERS` trong file
 * `notification-providers.ts` cùng thư mục này là nguồn sự thật DUY
 * NHẤT của luật phân phối thông báo phía API. Phía worker là một
 * project TypeScript riêng (app riêng trong monorepo), giữ một BẢN
 * CHIẾU viết tay tối thiểu của registry trong hằng số
 * `WORKER_PROVIDERS` (file `apps/worker/src/notification-delivery.service.ts`):
 * mỗi provider mà worker là nơi phát được chiếu đúng 3 trường luật —
 * `name`, `component`, `mandatoryInApp`. Trước spec này không có
 * kiểm tra tự động nào đối chiếu hai phía: registry đổi một trường
 * luật mà bản chiếu không cập nhật theo thì hai phía phân kỳ âm thầm.
 *
 * Vì sao spec này đọc bản chiếu phía worker DẠNG VĂN BẢN NGUỒN (fs)
 * thay vì import: hai app là hai project tsc riêng — import chéo app
 * làm file nguồn của app này lọt vào program của app kia và vỡ
 * typecheck (lỗi rootDir; đã vấp thật ở lượt CI đầu của issue này).
 * Đọc văn bản nguồn giữ nguyên tác dụng gác: spec này import registry
 * THẬT của chính app mình, trích bản chiếu thật từ source worker tại
 * thời điểm chạy, và khẳng định từng trường. Tuyệt đối không chép
 * cứng một bản sao thứ hai của registry vào test — chép snapshot thì
 * spec thành tự đối chiếu chính nó. Nếu định dạng khai báo
 * `WORKER_PROVIDERS` thay đổi (xuống dòng khác, thêm trường), phép
 * trích ở đây không khớp nữa và spec đỏ — đó là chủ ý: đổi hình dạng
 * bản chiếu thì phải cập nhật spec parity cùng lượt.
 *
 * Phạm vi parity — các trường THUỘC đối chiếu: `name`, `component`,
 * `mandatoryInApp` của mọi provider trong bản chiếu; cộng bề mặt
 * phát: mọi tên provider được phát qua `deliverInApp(` trong
 * apps/worker/src phải có mặt trong bản chiếu.
 *
 * NGOÀI parity (kèm lý do, đã ghi tường minh trong issue #293):
 * - `audience`: chỉ gác ở tầng tuỳ chọn phía API (lọc danh sách loại
 *   trong trang cài đặt theo vai + context thật, chặn PUT ngoài phía
 *   người nhận bằng lỗi 403 mã `messaging.preference_audience`);
 *   luật PHÁT của worker không đọc trường này — nơi phát phía worker
 *   đã biết đích danh người nhận. Bản chiếu vì vậy không mang
 *   `audience` (ca hình dạng bên dưới gác điều này: mỗi mục của bản
 *   chiếu phải có đúng 3 trường thuộc parity).
 * - `channels`: worker chỉ phát kênh trong-app; kênh ngoài là cổng
 *   xếp job phía API. `group`/`label`/`description`: thuần trình bày
 *   phía API/web.
 *
 * Nửa HÀNH VI của parity (luật cứng hai phía cho cùng kết quả:
 * đình chỉ / chính sách admin NB-7 / loại bắt buộc P2) nằm ở phía
 * worker — `apps/worker/test/notifications/notification-parity.spec.ts` — vì nó
 * phải chạy `NotificationDeliveryService` thật của worker.
 */

const WORKER_SRC_ROOT = join(__dirname, '../../../../worker/src');

interface MirrorEntry { name: string; component: string; mandatoryInApp: boolean }

/** Trích các mục của WORKER_PROVIDERS từ source worker, kèm khẳng định hình dạng đúng 3 trường. */
function extractWorkerMirror(): Map<string, MirrorEntry> {
  const source = readFileSync(join(WORKER_SRC_ROOT, 'notification-delivery.service.ts'), 'utf-8');
  const start = source.indexOf('export const WORKER_PROVIDERS');
  expect(start, 'WORKER_PROVIDERS must exist in worker notification-delivery.service.ts').toBeGreaterThanOrEqual(0);
  const block = source.slice(start, source.indexOf('};', start));
  const mirror = new Map<string, MirrorEntry>();
  for (const match of block.matchAll(/([a-z0-9_]+): \{([^}]*)\}/g)) {
    const key = match[1];
    const raw = match[2];
    const props = [...raw.matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    expect(props, `WORKER_PROVIDERS.${key} must carry exactly the three parity fields`).toEqual(['component', 'mandatoryInApp', 'name']);
    const name = /name: '([a-z0-9_]+)'/.exec(raw)?.[1];
    const component = /component: '([a-z0-9_]+)'/.exec(raw)?.[1];
    const mandatory = /mandatoryInApp: (true|false)/.exec(raw)?.[1];
    expect(name, `WORKER_PROVIDERS.${key}.name must be a string literal`).toBeDefined();
    expect(component, `WORKER_PROVIDERS.${key}.component must be a string literal`).toBeDefined();
    expect(mandatory, `WORKER_PROVIDERS.${key}.mandatoryInApp must be a boolean literal`).toBeDefined();
    mirror.set(key, { name: name!, component: component!, mandatoryInApp: mandatory === 'true' });
  }
  return mirror;
}

describe('Notification parity: worker mirror vs API registry (issue #293)', () => {
  it('the worker mirror is a faithful projection of the API registry on every law field in scope', () => {
    const mirror = extractWorkerMirror();
    expect(mirror.size).toBeGreaterThan(0);
    expect(MESSAGE_PROVIDERS.length).toBeGreaterThan(0);
    for (const [key, law] of mirror) {
      // Khoá của bản chiếu phải là chính tên provider.
      expect(law.name).toBe(key);
      // Provider phía worker có mà registry không có = phân kỳ, đỏ.
      const registryEntry = providerByName(key);
      expect(registryEntry, `WORKER_PROVIDERS.${key} must exist in the API registry`).toBeDefined();
      expect(law.component).toBe(registryEntry!.component);
      expect(law.mandatoryInApp).toBe(registryEntry!.mandatoryInApp ?? false);
    }
  });

  it('every provider emitted through deliverInApp in worker sources is registered in the mirror', () => {
    const mirror = extractWorkerMirror();
    const emitted = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf-8');
        for (const match of text.matchAll(/deliverInApp\(\s*[^,]+,\s*'([a-z0-9_]+)'/g)) {
          emitted.add(match[1]);
        }
      }
    };
    walk(WORKER_SRC_ROOT);
    // Có ít nhất các đường phát nền đã biết; tập rỗng nghĩa là phép
    // quét hỏng chứ không phải không còn đường phát nào.
    expect(emitted.size).toBeGreaterThan(0);
    for (const name of emitted) {
      expect(mirror.has(name), `worker emits '${name}' via deliverInApp but it is missing from WORKER_PROVIDERS`).toBe(true);
    }
  });
});
