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

Cấu trúc bao gói theo đúng mô hình monorepo chính thức của shadcn
(https://ui.shadcn.com/docs/monorepo), không dựa vào `paths` trong
tsconfig ở cả package lẫn app:

- Bên ngoài package, app chỉ đi qua trường `exports` của
  `package.json` (`./components/*`, `./lib/*`, `./hooks/*`,
  `./globals.css`) nhờ symlink workspace của pnpm.
- Import nội bộ package dùng alias cục bộ `#components/*`, `#lib/*`,
  `#hooks/*` khai trong trường `imports` của `package.json` — ví dụ
  `import { cn } from "#lib/utils"`. `components.json` khai cùng các
  alias này để CLI sinh file mới đúng chuẩn đó.
- `src/lib/utils.ts` là file thật chứa cài đặt `cn` chuẩn của shadcn
  (`clsx` + `tailwind-merge` là dependency của chính package này).

## Đồng bộ với shadcn

Chạy CLI ngay trong thư mục này (`components.json` đã trỏ alias và
file CSS theo package; `shadcn info` tại thư mục này nhận diện được
cấu hình và resolve đủ alias mà không cần dấu hiệu framework nào).
Sau khi đồng bộ: chạy `turbo run typecheck lint --filter=@lms/ui` và
build + test của `@lms/web`, đối chiếu diff của `components.json` và
`src/styles/globals.css` trước khi commit.

## Ngoại lệ so với bản shadcn sinh ra (kèm lý do)

- `src/hooks/use-mobile.ts`: khởi tạo `useIsMobile` đồng bộ bằng
  `window.innerWidth` ngay ở render đầu (bản gốc để `undefined` rồi
  mới set trong effect, gây một nhịp đổi khung trên máy nhỏ).
- `src/styles/globals.css`: thêm hai dòng `@source` trỏ tới cây nguồn
  của package và của `apps/web` — Tailwind v4 cần khai báo tường minh
  vì file CSS không còn nằm trong cây của app.
- `src/styles/globals.css`: khối `body { font-family: ui-sans-system
  ... }` của CSS thời tiền-package (không phải hàng shadcn) đã bị xoá
  khi áp preset Base Vega — khối đó không nằm trong layer nên thắng
  cả `@apply font-sans` của preset và chặn font Inter.
