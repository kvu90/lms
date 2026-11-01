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
| Font chữ của sản phẩm là Geist — Geist Sans cho font sans, Geist Mono cho font mono (bản Variable tự host qua `@fontsource-variable/geist` và `@fontsource-variable/geist-mono`), áp qua preset hiện hành — không nạp font ngoài theo trang. Tên font chỉ nằm ở chỗ nạp + hai token `--font-sans`/`--font-mono` trong `globals.css`; đổi họ font lần sau chỉ sửa đúng chỗ đó. | `globals.css` + ngoại lệ ghi ở cuối file |

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
- `src/components/message.tsx` (issue #608 — sửa lại một nửa mục
  ngay trên): `MessageAvatar` trả về `self-end` như bản gốc của
  component. Lý do: yêu cầu trang chat giống hệt bản demo ở lớp trình
  bày là yêu cầu bao trùm — phía demo avatar bám đáy hàng tin
  (`items-end`), và cấu trúc dòng tin hiện hành đã đổi theo demo
  (tên người gửi và avatar chỉ ở tin đầu cụm, xem issue #608) nên lý
  do neo đầu dòng của lát dọn gọn không còn đứng. Phần bỏ hack
  `group-has-data-[slot=message-footer]/message:-translate-y-8` của
  mục trên GIỮ NGUYÊN hiệu lực. Khi đồng bộ upstream: giữ `self-end`
  và giữ việc bỏ hack translate.
- `src/styles/globals.css` (issue #608): sửa tay ba giá trị màu tại
  gốc để khớp bảng màu của bản demo mà trang chat lấy làm chuẩn
  trình bày: `--destructive` (khối `:root`) đổi
  `oklch(0.577 0.245 27.325)` (#e7000b) thành
  `oklch(0.578 0.236 27.621)` (#e40014), và thêm hai biến ghi đè
  trong khối `@theme inline`: `--color-green-500: #00c758` và
  `--color-yellow-500: #edb200` (mặc định Tailwind v4 là #00c950 và
  #f0b100). Lý do sửa tay: đây là các token màu của preset mà hệ đã
  chọn lệch khỏi bảng màu demo ở mức rất nhỏ; shadcn CLI không có
  thao tác đổi từng giá trị token như vậy. Phạm vi ảnh hưởng là toàn
  ứng dụng (mọi bề mặt dùng biến thể destructive và hai màu trạng
  thái green/yellow-500), đã ghi rõ trong thân PR của issue #608.
  Khi đồng bộ upstream lần tới: đối chiếu ba giá trị này để giữ
  bảng màu demo thay vì quay về giá trị bản sinh ra mặc định mang
  theo.
- `src/styles/globals.css` (issue #623): sửa tay giá trị
  `--destructive` ở khối `.dark` từ `oklch(0.704 0.191 22.216)`
  (quy đổi #ff6467) thành `oklch(0.704 0.188 22.146)` (quy đổi
  #ff6568). Lý do: đợt rà soát toàn bộ trang chat so với bản
  demo phát hiện token chế độ tối lệch đúng 1 đơn vị ở kênh G
  so với giá trị demo #ff6568 (giá trị chế độ sáng đã khớp
  tuyệt đối #e40014 theo mục ngoại lệ của issue #608 ở trên);
  cùng lý do như mục đó — shadcn CLI không có thao tác đổi
  từng giá trị token. Khi đồng bộ upstream lần tới: đối chiếu
  giữ #ff6568 cho khối `.dark`.
- `src/components/avatar.tsx` (issue #608): sửa tay cỡ chữ nền của
  `AvatarFallback` từ `text-sm` (14px) thành `text-xs` (12px). Lý
  do: phía demo mọi avatar chữ viết tắt đều là 12px trong khi bản
  CLI sinh ra mang 14px ở cỡ mặc định — đây là lệch hệ thống lặp
  lại ở mọi avatar của sản phẩm, phải sửa tại đúng component gốc
  thay vì ghi đè ở từng nơi dùng. Khi đồng bộ upstream lần tới:
  đối chiếu dòng cỡ chữ này (bản sinh ra sẽ mang lại `text-sm`).
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
- `src/components/native-select.tsx` (issue #561, vòng sửa theo phán
  quyết điều phối `6518519302`): THÊM MỚI bằng shadcn CLI
  (`shadcn add native-select`, preset base-vega) chạy trong thư mục
  nháp riêng rồi đưa vào package — CLI trong môi trường thi công vẫn
  cần cấu hình alias đầy đủ (tsconfig `paths` + `imports` của
  package.json) và một lần chạy bị treo ở câu hỏi chọn thư viện
  primitive trước khi chạy được. Nội dung file là đúng bản
  NativeSelect của registry cho preset đang dùng, chỉ thích ứng một
  điểm duy nhất theo khuôn các component do CLI sinh trước đó trong
  package này: dòng import `cn` đổi từ package `cn` mà CLI hiện sinh
  sang `#lib/utils` (cùng cài đặt `cn` bằng clsx + tailwind-merge của
  package). Khi đồng bộ upstream lần tới: chạy
  `shadcn add native-select --overwrite` tại thư mục này và đối chiếu
  diff của file, đặc biệt dòng import `cn`.
- `src/styles/globals.css` (issue #599): đổi họ font toàn hệ từ Inter
  sang Geist bằng cách sửa tay hai dòng `@import` font và giá trị
  token `--font-sans`, đồng thời khai thêm token `--font-mono` (trước
  đó file chưa khai token này nên utility `font-mono` rơi về font đơn
  cách mặc định của Tailwind). Lý do: đổi họ font theo preset không có
  lệnh CLI tương ứng — CLI chỉ sinh file theo preset tại thời điểm
  init/add, không có thao tác đổi họ font; đây là thay đổi tối thiểu
  tại đúng lớp gián tiếp duy nhất của font (chỗ nạp + token) như
  quyết định về font ở đầu file này ghi. Khi đồng bộ upstream lần
  tới: đối chiếu hai dòng import và hai token font để giữ Geist thay
  vì quay về font mà bản sinh ra mặc định mang theo.
- `src/components/popover.tsx` (issue #591, vòng sửa PR #593):
  THÊM MỚI bằng shadcn CLI (`shadcn add popover -y`, preset
  base-vega) chạy tại thư mục package này — nội dung file là đúng
  bản Popover của registry cho preset đang dùng (primitive
  `@base-ui/react/popover`), chỉ thích ứng một điểm duy nhất như
  native-select: dòng import `cn` đổi từ package `cn` mà CLI hiện
  sinh sang `#lib/utils`. Bước cài phụ thuộc của CLI đòi
  `pnpm add cn` nhưng môi trường thi công không có `pnpm` trên
  PATH nên bước đó được bỏ qua (shim no-op chỉ cho lệnh `pnpm`
  của CLI): `cn` không phải package npm mà là module utils nội
  bộ của package (đã có sẵn), `package.json` không đổi, và
  `components.json` + `src/styles/globals.css` cũng không đổi
  sau lần chạy CLI này. Khi đồng bộ upstream lần tới: chạy
  `shadcn add popover --overwrite` tại thư mục này và đối chiếu
  diff của file, đặc biệt dòng import `cn`.
- `src/components/input-group.tsx` (issue #597, vòng sửa 2 của PR #601):
  THÊM MỚI bằng shadcn CLI (`shadcn add input-group --yes`, preset
  base-vega) chạy tại thư mục package này — nội dung file là đúng
  bản InputGroup của registry cho preset đang dùng, chỉ thích ứng một
  điểm duy nhất như native-select và popover: dòng import `cn` đổi từ
  package `cn` mà CLI hiện sinh sang `#lib/utils`. Bước cài phụ thuộc
  của CLI tự thêm `cn` vào `package.json`/`pnpm-lock.yaml` nhưng đã
  được gỡ ngay sau lần chạy (`cn` không phải dependency thật: `cn` là
  module utils nội bộ của package, đã có sẵn trong `src/lib/utils.ts`);
  ba file stock đã có trong package (`button.tsx`, `input.tsx`,
  `textarea.tsx`) được giữ nguyên khi CLI hỏi ghi đè.
  `components.json` + `src/styles/globals.css` không đổi sau lần chạy
  CLI này. Khi đồng bộ upstream lần tới: chạy
  `shadcn add input-group --overwrite` tại thư mục này và đối chiếu
  diff của file, đặc biệt dòng import `cn`.
