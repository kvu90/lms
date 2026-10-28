import { isIPv4 } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';

/**
 * Số chặng proxy tin cậy đứng trước ứng dụng: đúng MỘT chặng — tiến
 * trình web (prod-server) đứng ở biên, sau Cloudflare Tunnel. Chặng
 * proxy ở biên nối địa chỉ IP gốc mà nó quan sát được vào PHÍA PHẢI
 * của header `X-Forwarded-For` (prod-server giữ nguyên các chặng
 * trước rồi nối IP của socket nó nhận — xem
 * apps/web/server/prod-server.mjs), nên IP khách thật luôn là phần
 * tử phải nhất của danh sách; mọi phần tử bên trái đều do khách tự
 * khai và có thể giả mạo.
 *
 * Theo tài liệu chính thức của Express (guide "Behind proxies"),
 * `trust proxy` dạng số n nghĩa là chỉ tin tối đa n chặng tính từ
 * `req.socket.remoteAddress` đi ngược từ phải sang trái trong
 * `X-Forwarded-For`. Với n = 1, `req.ip` cho ra đúng phần tử phải
 * nhất (do chặng proxy ở biên nối thêm) khi chạy qua topology
 * production, và cho ra địa chỉ socket trực tiếp khi chạy local
 * không qua proxy — đúng ở cả hai môi trường.
 *
 * KHÔNG dùng `trust proxy = true`: giá trị đó tin toàn bộ danh sách
 * và lấy phần tử TRÁI NHẤT — phần tử khách giả mạo được — khiến mọi
 * nơi ghi IP (phiên, nhật ký đăng nhập, đối chiếu allowlist của đối
 * tác) đều bị qua mặt.
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * Bật cấu hình proxy tin cậy cho ứng dụng Express/Nest theo
 * {@link TRUSTED_PROXY_HOPS}. Phải gọi ngay sau khi tạo app (cả
 * `main.ts` lẫn helper dựng app cho test) để `req.ip` ở mọi
 * controller là IP khách thật; throttler của Nest cũng tự khoá rate
 * limit theo IP đó vì nó đọc cùng `req.ip`.
 */
export function enableTrustedProxy(app: Pick<NestExpressApplication, 'set'>): void {
  app.set('trust proxy', TRUSTED_PROXY_HOPS);
}

/**
 * Chuẩn hoá một địa chỉ IP trước khi ghi xuống phiên/nhật ký: cắt
 * tiền tố `::ffff:` (dạng IPv4 ánh xạ vào IPv6 mà Node trả về cho
 * kết nối IPv4 trên socket dual-stack) CHỈ khi phần còn lại là IPv4
 * hợp lệ. IPv6 thuần và mọi giá trị khác giữ nguyên; đầu vào
 * undefined/rỗng trả về nguyên trạng để nơi gọi tự quyết định giá
 * trị thay thế.
 */
export function normalizeIpAddress(ip: string | undefined): string | undefined {
  if (!ip) return ip;
  const prefix = '::ffff:';
  if (ip.startsWith(prefix)) {
    const rest = ip.slice(prefix.length);
    if (isIPv4(rest)) return rest;
  }
  return ip;
}

/**
 * ĐIỂM LẤY IP KHÁCH DUY NHẤT cho các controller: đọc `req.ip` — giá
 * trị Express đã tính từ cấu hình proxy tin cậy (xem
 * {@link enableTrustedProxy}) — rồi chuẩn hoá qua
 * {@link normalizeIpAddress}. Controller không được tự đọc header
 * `X-Forwarded-For` hay `req.socket.remoteAddress`, vì đọc tay rất
 * dễ lấy nhầm phần tử giả mạo ở đầu danh sách.
 */
export function clientIpOf(req: Pick<Request, 'ip'>): string | undefined {
  return normalizeIpAddress(req.ip);
}
