# @lms/web

Ứng dụng web LMS: React + React Router ở chế độ framework (SPA,
`ssr: false`) + TanStack Query. Bản build tĩnh nằm ở `build/client`,
được `apps/api` phục vụ (biến môi trường `WEB_DIST_DIR` trỏ tới thư
mục đó). Dev server proxy `/api` sang backend cổng 3000:

```bash
pnpm dev   # http://localhost:5173
```

## Cấu trúc thư mục

- `src/routes.ts` + `src/routes/` — khai báo route của React Router
  framework mode; `src/root.tsx` là root route (Layout, HydrateFallback,
  ErrorBoundary, QueryClientProvider, AuthProvider).
- `src/pages/` — các trang nghiệp vụ; mọi trang chỉ dùng dữ liệu thật
  qua lớp `src/lib/api.ts` và TanStack Query (`src/lib/query-keys.ts`
  là nơi tập trung query key).
- `src/components/` — component TỰ VIẾT của ứng dụng (app-sidebar,
  section-cards, data-table, các skeleton giữ hình học...).

## Ranh giới UI shadcn — đọc trước khi sửa giao diện

Toàn bộ component shadcn/ui sống trong package riêng **`@lms/ui`**
(`packages/ui`), KHÔNG còn nằm trong `apps/web`:

- `apps/web` chỉ *dùng* qua import `@lms/ui/components/<tên>`,
  `@lms/ui/hooks/<tên>` và `@lms/ui/globals.css`. Cấm sao chép một
  component của package vào `src/components/` để sửa riêng — sửa lén
  như vậy sẽ bị ghi đè mất ở lần đồng bộ shadcn kế tiếp.
- Component tự viết (bọc, biến thể theo nghiệp vụ, skeleton...) luôn
  nằm ở `apps/web/src/components/`, import `@lms/ui` như mọi thư viện
  khác.
- Quy tắc bất biến của package và cách đồng bộ/nâng cấp nằm trong
  `packages/ui/README.md`.
