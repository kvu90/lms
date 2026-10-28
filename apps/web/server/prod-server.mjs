/**
 * Tiến trình SSR của apps/web (Giai đoạn 3 của issue #7, topology C).
 *
 * Một tiến trình Node thuần (không framework ngoài) giữ ba vai:
 *   1. Mặt tiền HTTP duy nhất: bind cổng PUBLIC_PORT (mặc định $PORT
 *      do môi trường triển khai cấp).
 *   2. Proxy các đường của API (xem `proxy-paths.mjs`: `/api/*`,
 *      `/socket.io/*`, `/mcp`, `/.well-known/oauth-protected-resource`)
 *      về API ở địa chỉ nội bộ
 *      (LMS_API_INTERNAL_URL, mặc định http://127.0.0.1:3000): chuyển
 *      nguyên header (Cookie đi lên, Set-Cookie — kể cả nhiều header —
 *      đi xuống), nối tiếp chuỗi X-Forwarded-For của chặng trước, và
 *      STREAM không đệm để SSE sống qua proxy; trình duyệt đóng kết
 *      nối thì hủy luôn request phía API. WebSocket (socket.io) đi qua
 *      đường hầm TCP ở sự kiện `upgrade`.
 *   3. Phục vụ asset tĩnh của bản build client (tên file có hash →
 *      cache immutable; asset text được nén brotli/gzip theo
 *      Accept-Encoding — xem `compression.mjs`, CHỈ ở đường tĩnh này)
 *      và giao mọi request còn lại cho server build
 *      của React Router (SSR) qua createRequestListener. Mọi tài
 *      liệu HTML ở cả hai đường (tĩnh lẫn SSR) đều mang header bảo
 *      mật Content-Security-Policy — xem `security-headers.mjs`.
 *
 * Chạy độc lập: `node server/prod-server.mjs` (cần `react-router
 * build` trước) — đây cũng là cách target `web` của Dockerfile ở gốc
 * repo chạy tiến trình này trong stack Docker Compose. Chạy cả
 * topology ở local thì khởi động thêm tiến trình API riêng
 * (`apps/api/dist/main.js`) và trỏ `LMS_API_INTERNAL_URL` về API đó.
 */
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestListener } from '@react-router/node';
import * as serverBuild from '../build/server/index.js';
import { isProxyPath } from './proxy-paths.mjs';
import { compressBuffer, isCompressibleType, MIN_COMPRESS_BYTES, pickEncoding } from './compression.mjs';
import { applyDocumentSecurityHeaders } from './security-headers.mjs';

const apiOrigin = new URL(process.env.LMS_API_INTERNAL_URL ?? 'http://127.0.0.1:3000');
const publicPort = Number(process.env.PORT ?? process.env.PUBLIC_PORT ?? 8080);
const clientDir = fileURLToPath(new URL('../build/client/', import.meta.url));

const ssrListener = createRequestListener({
  build: serverBuild,
  mode: process.env.NODE_ENV ?? 'production',
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Chuỗi X-Forwarded-For: giữ nguyên các chặng trước rồi nối IP của chặng proxy này. */
function forwardedFor(req) {
  const prior = req.headers['x-forwarded-for'];
  const clientIp = req.socket.remoteAddress ?? '';
  return prior ? `${prior}, ${clientIp}` : clientIp;
}

/** Proxy HTTP stream hai chiều, không đệm (SSE sống), hủy theo kết nối của trình duyệt. */
function proxyHttp(req, res) {
  const headers = { ...req.headers, host: apiOrigin.host, 'x-forwarded-for': forwardedFor(req) };
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http';
  const upstream = httpRequest(
    {
      hostname: apiOrigin.hostname,
      port: apiOrigin.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (upRes) => {
      // upRes.headers giữ nguyên mảng set-cookie → writeHead phát lại đủ từng header.
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    console.error('[ssr] proxy error', error.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway');
  });
  // Trình duyệt đóng kết nối (điều hướng đi, đóng tab) → hủy request
  // phía API để subscription SSE được đóng theo, không rò rỉ.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

/** Đường hầm TCP cho WebSocket upgrade của socket.io. */
function proxyUpgrade(req, socket, head) {
  if (!req.url?.startsWith('/socket.io/')) {
    socket.destroy();
    return;
  }
  const upstream = netConnect(Number(apiOrigin.port), apiOrigin.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    const raw = req.rawHeaders;
    let hostSeen = false;
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i];
      const lower = name.toLowerCase();
      if (lower === 'host') {
        lines.push(`Host: ${apiOrigin.host}`);
        hostSeen = true;
      } else if (lower === 'x-forwarded-for') {
        lines.push(`${name}: ${raw[i + 1]}, ${req.socket.remoteAddress ?? ''}`);
      } else {
        lines.push(`${name}: ${raw[i + 1]}`);
      }
    }
    if (!hostSeen) lines.push(`Host: ${apiOrigin.host}`);
    if (!req.headers['x-forwarded-for']) lines.push(`X-Forwarded-For: ${req.socket.remoteAddress ?? ''}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

/**
 * Tài liệu đã prerender lúc build (khai ở `prerender` trong
 * react-router.config.ts, lát SL-1 của #7): đường dẫn tài liệu → file
 * HTML tĩnh trong build/client (React Router sinh `<path>/index.html`).
 * Chỉ hai mặt công khai `/` và `/login` — xem luật phục vụ ở tryStatic.
 */
const PRERENDERED_DOCUMENTS = new Map([
  ['/', 'index.html'],
  ['/login', 'login/index.html'],
]);

/** Mẫu nhận diện cookie phiên Better Auth — cùng mẫu với loader gốc phía app (bản https có tiền tố `__Secure-`). */
const SESSION_COOKIE_PATTERN = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/** Phục vụ file tĩnh từ build/client; trả true nếu đã xử lý. */
async function tryStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  // Tài liệu prerender: ánh xạ đường dẫn về file HTML đã sinh lúc
  // build (đường dẫn thường không trỏ thẳng tới file). Luật phiên là
  // bất biến an toàn của lát SL-1: request mang cookie phiên Better
  // Auth thì KHÔNG BAO GIỜ nhận bản tĩnh — trả false để rơi xuống
  // SSR động theo đúng phiên (mặt đã đăng nhập của `/` được cá nhân
  // hoá bởi loader gốc); chỉ request ẩn danh mới nhận bản prerender.
  const documentPath = urlPath.length > 1 ? urlPath.replace(/\/+$/, '') : urlPath;
  const prerenderedFile = PRERENDERED_DOCUMENTS.get(documentPath);
  if (prerenderedFile && SESSION_COOKIE_PATTERN.test(req.headers.cookie ?? '')) return false;
  const filePath = normalize(join(clientDir, prerenderedFile ?? urlPath));
  if (!filePath.startsWith(normalize(clientDir))) return false;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    // Tài liệu prerender vẫn là TÀI LIỆU (không phải asset): giữ
    // chính sách không cache công khai như headers() của root phía
    // app — giá trị của prerender là bỏ chi phí render SSR, không
    // phải cache ở tầng trung gian/trình duyệt.
    const cache = prerenderedFile
      ? 'private, no-cache'
      : urlPath.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
    const body = await readFile(filePath);
    const headers = { 'Content-Type': type, 'Cache-Control': cache };
    // Tài liệu HTML tĩnh (gồm bản prerender) mang cùng header bảo
    // mật như tài liệu SSR — xem security-headers.mjs. Đặt qua
    // object header của writeHead vì đường tĩnh không đi qua
    // ServerResponse.setHeader như đường SSR.
    if (type.startsWith('text/html')) {
      const docRes = { setHeader: (name, value) => { headers[name] = value; } };
      applyDocumentSecurityHeaders(docRes);
    }
    let payload = body;
    // Nén CHỈ ở đường tĩnh này (F-12 của #133): SSR streaming và proxy
    // không đi qua đây. File text đủ lớn + client chấp nhận thì nén,
    // kèm Vary để cache trung gian tách đúng biến thể theo Accept-Encoding.
    if (isCompressibleType(type)) {
      headers.Vary = 'Accept-Encoding';
      const encoding = info.size >= MIN_COMPRESS_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
      if (encoding) {
        payload = compressBuffer(body, encoding);
        headers['Content-Encoding'] = encoding;
      }
    }
    headers['Content-Length'] = payload.length;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(payload);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.url && isProxyPath(req.url)) return proxyHttp(req, res);
    if (await tryStatic(req, res)) return;
    // Mọi đáp ứng còn lại là tài liệu SSR của React Router (kèm các
    // đáp ứng dữ kiện điều hướng của nó): gắn header bảo mật tài
    // liệu TRƯỚC khi giao cho listener — header đặt bằng setHeader
    // được giữ nguyên khi listener gọi writeHead với bộ header của
    // riêng nó (không có CSP) — xem security-headers.mjs.
    applyDocumentSecurityHeaders(res);
    return ssrListener(req, res);
  } catch (error) {
    console.error('[ssr] request error', error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});
server.on('upgrade', proxyUpgrade);

server.listen(publicPort, () => {
  console.log(`[ssr] listening on :${publicPort}, api internal ${apiOrigin.href}`);
});
