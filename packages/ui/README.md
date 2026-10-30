# @lms/ui — README

> File này ghi các **quyết định quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách gì

`packages/ui` là **lớp giao diện shadcn/ui dùng chung** của toàn sản phẩm — tách riêng
khỏi `apps/web` để mỗi lần shadcn phát hành bản mới chỉ cần đồng bộ package này,
không đụng vào mã ứng dụng. Package này không mang nghiệp vụ: nó mang **kỷ luật
hình thức dùng chung** — mọi bề mặt của sản phẩm phải trông và cư xử như MỘT sản
phẩm, qua cùng một bộ component nền.

## Quyết định còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Toàn bộ component shadcn/ui của dự án sống DUY NHẤT ở package này. `apps/web` chỉ dùng qua `@lms/ui/...`, cấm sao chép component vào app để sửa riêng. Component nghiệp vụ tự viết nằm ở `apps/web/src/components/`. | README gốc của package; README của apps/web |
| Nhất quán hình thức là yêu cầu bắt buộc, không phải trang trí: các vỏ tương tác dùng chung (collapse/section, dialog, bảng…) dùng MỘT component/khuôn chung cho mọi trang — mỗi trang tự chế một kiểu vỏ là lỗi (đã ghi nhận 3 kiểu collapse khác nhau trên trang /questions, 25/10/2026 — lát UI-1 thống nhất vỏ). | Yêu cầu nghiệp vụ ngày 25/10/2026 23:04; issue #133 (UI-1) |
| Font chữ của sản phẩm là Inter (bản Variable tự host qua `@fontsource-variable/inter`), áp qua preset hiện hành — không nạp font ngoài theo trang. | `globals.css` + ngoại lệ ghi ở cuối file |

## Bất biến

- `src/components/**` và `src/styles/globals.css` là hàng do shadcn
  CLI sinh ra: **chỉ** thay đổi bằng CLI (`shadcn add --overwrite`,
  `shadcn init --preset ...` chạy tại thư mục package này) hoặc bằng
  quy trình chuyển nền/chuyển preset có ghi chép; không sửa tay lắt
  nhắt. Mọi ngoại lệ bất khả kháng phải liệt kê ở cuối file này kèm
  lý do.
- Mã tự viết của dự án KHÔNG được đặt trong package này; component
  nghiệp vụ nằm ở `apps/web/src/components/`.

## Cách các ứng dụng dùng

```tsx
import { Button } from '@lms/ui/components/button';
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
Sau khi đồng bộ: chạy `turbo run typecheck --filter=@lms/ui` và
build + test của `@lms/web`, đối chiếu diff của `components.json` và
`src/styles/globals.css` trước khi commit.

## Ngoại lệ so với bản shadcn sinh ra (kèm lý do)

- `src/hooks/use-mobile.ts`: khởi tạo `useIsMobile` đồng bộ bằng
  `window.innerWidth` ngay ở render đầu (bản gốc để `undefined` rồi
  mới set trong effect, gây một nhịp đổi khung trên máy nhỏ).
- `src/styles/globals.css`: thêm hai dòng `@source` trỏ tới cây nguồn
  của package và của `apps/web` — Tailwind v4 cần khai báo tường minh
  vì file CSS không còn nằm trong cây của app.
- `src/styles/globals.css` (lát E1, issue #248): thêm dòng `@source`
  thứ ba trỏ tới cây nguồn của `packages/editor` — từ lát này package
  editor dùng class Tailwind trong component của chính nó (panel công
  thức dạng overlay, toolbar), không khai báo thì các class đó không
  sinh CSS ở bản dựng của `apps/web`.
- `src/styles/globals.css`: khối `body { font-family: ui-sans-system
  ... }` của CSS thời tiền-package (không phải hàng shadcn) đã bị xoá
  khi áp preset Base Vega — khối đó không nằm trong layer nên thắng
  cả `@apply font-sans` của preset và chặn font Inter.
- `src/components/message.tsx` (lát dọn gọn UI nhắn tin, nối tiếp
  issue #33): `MessageAvatar` đổi `self-end` thành `self-start` và bỏ
  hack `group-has-data-[slot=message-footer]/message:-translate-y-8`.
  Lý do: `MessageAvatar` là component riêng của hệ (không có trong bộ
  shadcn upstream), cột nội dung cạnh avatar xếp header → bong bóng →
  hàng hành động → footer nên neo đáy + translate theo footer làm
  avatar lệch xuống ngang hàng tuỳ chọn dưới tin nhắn; neo đầu dòng
  mới khớp trình bày chuẩn của các app nhắn tin. Khi đồng bộ upstream:
  giữ nguyên thay đổi này (file không bị CLI ghi đè vì upstream không
  có component `message`).
- `src/components/breadcrumb.tsx` và `src/components/marker.tsx`
  (issue #394): đã XOÁ khỏi package. Lý do: tại thời điểm xoá, quét
  toàn repo theo tên file, tên export và đường import `@lms/ui/...`
  cho 0 điểm dùng ngoài chính hai file — hai component do CLI sinh ra
  nhưng không bề mặt nào của sản phẩm sử dụng, giữ lại chỉ tạo ấn
  tượng sai rằng chúng là một phần của bộ component đang dùng. Nếu
  lần đồng bộ shadcn sau sinh lại hai file này, đánh giá lại theo nhu
  cầu dùng thật tại thời điểm đó thay vì giữ sẵn.
- `src/components/drawer.tsx`, `src/components/sonner.tsx` và
  `src/components/radio-group.tsx` (issue #438): đã XOÁ khỏi package,
  kèm các dependency chỉ còn chúng dùng (`vaul`, `sonner`,
  `next-themes`) và selector mồ côi
  `has-[>[data-slot=radio-group]]:gap-3` trong
  `src/components/field.tsx`. Lý do: tại thời điểm xoá, quét toàn repo
  theo tên file, tên export và đường import cho 0 điểm dùng ngoài
  chính các file này — component stock do CLI sinh ra nhưng không bề
  mặt nào của sản phẩm sử dụng, giữ lại chỉ tạo ấn tượng sai rằng
  chúng là một phần của bộ component đang dùng. Nếu lần đồng bộ
  shadcn sau sinh lại các file này, đánh giá lại theo nhu cầu dùng
  thật tại thời điểm đó thay vì giữ sẵn.
- `src/components/dialog.tsx` (issue #561): THÊM MỚI bằng tay thay vì
  bằng shadcn CLI. Lý do bất khả kháng: CLI `shadcn add dialog` không
  chạy được trong môi trường thi công của đợt này (bước cài phụ thuộc
  của CLI thất bại vì môi trường không có `pnpm` trên PATH và bản sao
  `node_modules` không phải cây cài thật, lần chạy lại thì CLI treo
  không ra kết quả). Nội dung file bám đúng bản Dialog của registry
  shadcn cho preset đang dùng (base-vega, primitive
  `@base-ui/react/dialog`) và khuôn sinh sẵn của package — cùng
  primitive và cùng quy ước `data-slot`/nút đóng như
  `src/components/sheet.tsx` do CLI sinh trước đó; không thêm biến thể
  hình thức riêng nào ngoài bản upstream. Khi đồng bộ upstream lần
  tới: chạy `shadcn add dialog --overwrite` tại thư mục này và đối
  chiếu diff của file để thay bản viết tay bằng bản CLI sinh.
