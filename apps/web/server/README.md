# Tiến trình SSR + topology C (Giai đoạn 3–4, issue #7)

Hai file thuần Node (không bước biên dịch riêng), chạy trên bản build
của `react-router build` (ssr: true → `build/server` + `build/client`)
và bản build của API (`apps/api/dist/main.js`).

| File | Vai |
|---|---|
| `prod-server.mjs` | Tiến trình SSR: bind cổng công khai, phục vụ asset `build/client`, proxy `/api/*` + `/socket.io/*` (HTTP stream không đệm cho SSE + đường hầm upgrade cho WebSocket) về API nội bộ, giao phần còn lại cho server build React Router. |
| `launcher.mjs` | Launcher topology C: chạy API (cổng nội bộ, không phát tĩnh) + SSR (cổng công khai) trong cùng một đơn vị chạy; chuyển tín hiệu tắt; một tiến trình con chết thì cả cặp thoát để nền tảng restart toàn bộ. |

## Chạy prototype local

```bash
# Từ gốc repo: build API + web
pnpm --filter @lms/api build
pnpm --filter @lms/web build

# Môi trường cho API (DATABASE_URL trỏ DB đã áp baseline + seed,
# REDIS_URL, JWT_SECRET...) đặt trước khi chạy launcher, ví dụ:
DATABASE_URL=postgres://... REDIS_URL=redis://127.0.0.1:6379 JWT_SECRET=... \
  pnpm --filter @lms/web start:topology
# → mở http://localhost:8080 (PORT ghi đè được; cổng API nội bộ qua
#   API_INTERNAL_PORT, mặc định 3100)
```

Chỉ chạy riêng tiến trình SSR (API tự lo): `pnpm --filter @lms/web start`
với `LMS_API_INTERNAL_URL` trỏ tới API (mặc định `http://127.0.0.1:3000`).

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 8080 (launcher/prod-server) | Cổng công khai của tiến trình SSR — trên Heroku là cổng dyno cấp. |
| `API_INTERNAL_PORT` | 3100 | Cổng nội bộ của API khi chạy qua launcher. |
| `LMS_API_INTERNAL_URL` | `http://127.0.0.1:3000` | Địa chỉ API nội bộ cho proxy và cho loader phía server. Launcher tự đặt theo `API_INTERNAL_PORT`. |

Trạng thái: Giai đoạn 4 — SSR toàn bộ route đã thi công trên nền
prototype này; Procfile production ĐÃ chuyển sang launcher (web dyno
chạy topology C). Cổng merge: chỉ merge sau khi dyno web nâng lên
Standard-2X (đo RAM: cặp tiến trình đỉnh ≈484 MB, Eco 512 MB NO-GO);
main chat điều phối cửa sổ merge + nâng gói.
