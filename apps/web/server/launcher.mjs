/**
 * Launcher topology C (Giai đoạn 3 của issue #7): khởi động HAI tiến
 * trình con trong cùng một "dyno" — đúng mô hình sẽ dùng trên Heroku:
 *
 *   trình duyệt ──► [SSR :$PORT] ──proxy /api/*──► [API :127.0.0.1:$API_INTERNAL_PORT]
 *
 * - SSR (apps/web/server/prod-server.mjs) bind cổng công khai ($PORT,
 *   mặc định 8080 khi chạy local), API chỉ nghe ở cổng nội bộ
 *   (API_INTERNAL_PORT, mặc định 3100) và KHÔNG phục vụ tĩnh web
 *   (WEB_DIST_DIR bị gỡ khỏi môi trường của tiến trình con).
 * - Launcher chuyển tiếp SIGTERM/SIGINT cho cả hai con; một con chết
 *   thì launcher giết con còn lại và thoát theo — trên Heroku, dyno
 *   restart kéo cả cặp lên lại, không để trạng thái nửa vời (SSR sống
 *   mà API chết, hay ngược lại).
 *
 * Điều kiện chạy: đã build cả API (`apps/api/dist/main.js`) và web
 * (`apps/web/build`). Môi trường cho API (DATABASE_URL, REDIS_URL,
 * JWT_SECRET…) được thừa hưởng nguyên từ môi trường của launcher.
 *
 * Dùng: `node server/launcher.mjs` từ thư mục apps/web, hoặc script
 * `pnpm --filter @lms/web start:topology`.
 *
 * Biến môi trường của cả topology (launcher tự đặt cho hai con):
 * - `PORT` (mặc định 8080): cổng công khai của tiến trình SSR — trên
 *   Heroku là cổng dyno cấp.
 * - `API_INTERNAL_PORT` (mặc định 3100): cổng nội bộ của API khi chạy
 *   qua launcher; địa chỉ API nội bộ cho SSR được launcher tự suy ra
 *   từ cổng này.
 * - `LMS_API_INTERNAL_URL` (mặc định `http://127.0.0.1:3000` khi SSR
 *   chạy độc lập): địa chỉ API nội bộ cho proxy và cho loader phía
 *   server. Khi chạy qua launcher, biến này do launcher đặt theo
 *   `API_INTERNAL_PORT`, không cần tự cấp.
 *
 * Chạy prototype local (từ gốc repo): build cả API và web trước, cấp
 * môi trường cho API (DATABASE_URL trỏ DB đã áp baseline + seed,
 * REDIS_URL, JWT_SECRET…) rồi chạy qua launcher:
 *
 *   pnpm --filter @lms/api build
 *   pnpm --filter @lms/web build
 *   DATABASE_URL=postgres://... REDIS_URL=redis://127.0.0.1:6379 JWT_SECRET=... \
 *     pnpm --filter @lms/web start:topology
 *   # → mở http://localhost:8080 (PORT ghi đè được)
 *
 * Chỉ chạy riêng tiến trình SSR (API tự lo): `pnpm --filter @lms/web
 * start` với `LMS_API_INTERNAL_URL` trỏ tới API.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const publicPort = process.env.PORT ?? '8080';
const apiPort = process.env.API_INTERNAL_PORT ?? '3100';
const apiInternalUrl = `http://127.0.0.1:${apiPort}`;

const apiEnv = { ...process.env, PORT: apiPort, NODE_ENV: process.env.NODE_ENV ?? 'production' };
delete apiEnv.WEB_DIST_DIR; // Topology C: API không còn vai trò phát web.

const children = new Map();
let shuttingDown = false;

function start(name, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    console.log(`[launcher] ${name} exited (code=${code}, signal=${signal ?? 'none'})`);
    children.delete(name);
    if (!shuttingDown) {
      // Một con chết là cả dyno phải restart theo thiết kế topology C.
      shutdown(code ?? 1);
    } else if (children.size === 0) {
      process.exit(code ?? 0);
    }
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) child.kill('SIGTERM');
  // Trần chờ thoát mềm; quá hạn thì giết cứng để dyno restart đúng hạn.
  setTimeout(() => process.exit(code), 5_000).unref();
  if (children.size === 0) process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

console.log(`[launcher] topology C: SSR :${publicPort} → API ${apiInternalUrl}`);
start('api', 'node', [`${repoRoot}apps/api/dist/main.js`], { cwd: repoRoot, env: apiEnv });
start('ssr', 'node', [`${webDir}server/prod-server.mjs`], {
  cwd: webDir,
  env: { ...process.env, PORT: publicPort, LMS_API_INTERNAL_URL: apiInternalUrl, NODE_ENV: process.env.NODE_ENV ?? 'production' },
});
