# @lms/ui

Package chứa toàn bộ lớp giao diện shadcn/ui của dự án — tách riêng
khỏi `apps/web` để mỗi lần shadcn phát hành bản mới chỉ cần đồng bộ
package này, không đụng vào mã ứng dụng.

## Bất biến

- `src/components/ui/**` và `src/styles/globals.css` là hàng do shadcn
  CLI sinh ra: **chỉ** thay đổi bằng CLI (`shadcn add --overwrite`,
  `shadcn init --preset ...` chạy tại thư mục package này) hoặc bằng
  quy trình chuyển nền/chuyển preset có ghi chép; không sửa tay lắt
  nhắt. Mọi ngoại lệ bất khả kháng phải liệt kê ở cuối file này kèm
  lý do.
- Mã tự viết của dự án KHÔNG được đặt trong package này; component
  nghiệp vụ nằm ở `apps/web/src/components/`.

## Cách các ứng dụng dùng

```tsx
import { Button } from '@lms/ui/components/ui/button';
import { useIsMobile } from '@lms/ui/hooks/use-mobile';
import '@lms/ui/globals.css'; // chỉ import một lần ở root của app
```

Import nội bộ package cũng dùng chính tên `@lms/ui/...` (tự tham
chiếu) để file sinh ra giữ nguyên một dạng ở mọi ngữ cảnh biên dịch.

## Đồng bộ với shadcn

Chạy CLI ngay trong thư mục này (`components.json` đã trỏ alias và
file CSS theo package). Sau khi đồng bộ: chạy `turbo run typecheck
lint --filter=@lms/ui` và build + test của `@lms/web`, đối chiếu diff
của `components.json` và `src/styles/globals.css` trước khi commit.

## Ngoại lệ so với bản shadcn sinh ra (kèm lý do)

- `src/components/ui/sidebar.tsx`, `src/components/ui/toggle-group.tsx`:
  các import nội bộ (`@/components/ui/*`, `@/hooks/use-mobile`) được
  viết lại thành `@lms/ui/components/ui/*`, `@lms/ui/hooks/use-mobile`
  — đổi đường dẫn thuần túy để package tự chứa, không đổi logic/mẫu.
- `src/hooks/use-mobile.ts`: khởi tạo `useIsMobile` đồng bộ bằng
  `window.innerWidth` ngay ở render đầu (bản gốc để `undefined` rồi
  mới set trong effect, gây một nhịp đổi khung trên máy nhỏ).
- `src/styles/globals.css`: thêm hai dòng `@source` trỏ tới cây nguồn
  của package và của `apps/web` — Tailwind v4 cần khai báo tường minh
  vì file CSS không còn nằm trong cây của app.
- Các component dùng `import { cn } from "cn"` (package `cn`) thay
  cho `@/lib/utils` như bản gốc — hiện trạng có từ trước khi tách
  package, giữ nguyên để không lẫn thay đổi vào đợt tách.
