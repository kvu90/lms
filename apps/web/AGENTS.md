# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `apps/web`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của `apps/web`.
2. Issue đặc tả của việc đang làm trên GitHub — nguồn sự thật cho việc đó: bối cảnh,
   phạm vi, các quyết định liên quan (viết trọn vẹn ngay trong issue) và tiêu chí
   nghiệm thu đều nằm trong chính issue. Không viện dẫn sổ quyết định, hồ sơ hay tệp
   ngoài repo làm căn cứ. Tài liệu trong repo mâu thuẫn với issue thì DỪNG, báo
   main chat.
3. `AGENTS.md` ở thư mục gốc của repo — quy định chung cho AI toàn repo, gồm chuẩn
   văn bản tự chứa cho issue và PR.

## Chuẩn ngôn ngữ

Code (định danh, tên hàm/biến/lớp, chuỗi kỹ thuật) viết bằng tiếng Anh.
Toàn bộ comment trong code — gồm comment mô tả luồng nghiệp vụ — viết
bằng tiếng Việt. Mọi tài liệu trong repo (README, các file AGENTS, tài
liệu của package) và mọi văn bản trên GitHub (issue, PR, comment) viết
bằng tiếng Việt. Khi sửa code, comment tiếng Việt liên quan phải được
cập nhật khớp với code trong cùng lượt thay đổi. Nội dung đầy đủ của
chuẩn này nằm ở mục "Chuẩn ngôn ngữ" trong `AGENTS.md` ở thư mục gốc
của repo.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR; việc phát sinh của cùng feat comment vào đúng issue đó.
- Chỉ trình bày + dẫn luồng. Thấy thiếu gác quyền ở API thì ghi nhận/báo, không tự
  "vá" bằng cách giấu phần tử giao diện (bài học #134: giấu UI không phải là gác).

## Điều cấm package-specific

- Cấm sao chép component shadcn từ `packages/ui` vào `src/components/` để sửa riêng;
  cần đổi hành vi thì bọc component ở `apps/web/src/components/` hoặc sửa ở package ui
  theo quy trình của package đó.
- Cấm tự chế kiểu collapse/section/accordion riêng cho từng trang — dùng component
  dùng chung đã thống nhất; giữ nguyên hành vi đã nghiệm thu (trạng thái mở/đóng,
  neo URL + scroll) khi thay vỏ.
- Cấm hiển thị nguồn sách trên bề mặt học sinh làm bài, cấm hiển thị điểm chưa công
  bố cho HS/PH — kể cả khi API lỡ trả thừa trường (lọc ở tầng hiển thị + báo API sửa).
- Cấm dựng lại bề mặt blog/hỏi-đáp (đã gỡ theo chốt 25/10/2026) và cấm thêm mục điều
  hướng ngoài cấu trúc sidebar đã chốt trong sổ quyết định.
- Cấm đổi cấu trúc sidebar ngân hàng khác 3 mục top-level + tab Cá nhân/Hệ thống trong từng màn danh sách đã chốt (sổ mục B, chốt lại 26/10/2026 11:40).

## Kiểm chứng bắt buộc

- **Typecheck trước khi push**: `pnpm --filter @lms/web typecheck` (build của web có
  kèm typecheck). Dist cũ của `@lms/ui`/`@lms/editor`/`@lms/contracts` là nguồn lỗi
  type giả — build lại package phụ thuộc trước khi kết luận.
- Feat lớn xong phải có lượt nghiệm thu trên **trình duyệt thật** bằng tài khoản seed
  đổi đủ vai liên quan (tài khoản demo ghi công khai trong README gốc của repo — tự
  đọc mà dùng, tự gõ vào form đăng nhập, không xin lại thông tin đăng nhập, không chờ thẻ
  Secure Vault).
- Kiểm chứng gồm cả **tính nhất quán hình thức** (vỏ component, trạng thái hover,
  chevron, khoảng cách) — không chỉ kiểm cấu trúc/chức năng.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Local chỉ test targeted
  (`pnpm --filter @lms/web test -- <spec liên quan>`); suite nặng phải giữ khoá
  `flock /tmp/lms-heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Test web phải thể hiện luồng người dùng thật theo vai (GV tạo khoá trong lớp, HS
  chỉ thấy điểm đã công bố, HS không thấy nhóm ngân hàng…), không test chi tiết
  triển khai (tên class, cấu trúc DOM trung gian). Đổi quyết định nghiệp vụ thì test
  tương ứng phải fail — xanh giả là test sai, sửa cùng lượt.
- Neo URL/trạng thái điều hướng đã nghiệm thu là hành vi nghiệp vụ: test phải giữ
  được chúng khi refactor vỏ.

## Cấu trúc tầng test

- `apps/web` chỉ có **một tầng test: unit**. Mọi spec là test đơn vị/component
  render trong jsdom với dữ liệu/API được mock; spec `.spec.ts`/`.spec.tsx`
  đặt cạnh file nguồn trong `src/`, riêng spec `.spec.mjs` của các module
  server Node của app đặt trong `server/`.
- Cấu trúc `test/e2e/`, `test/integration/` cùng hậu tố `.e2e-spec`/`.int-spec`
  là của backend (`apps/api`, `apps/worker`) — không áp dụng cho web và không
  tạo tầng rỗng cho web.
- `vitest.config.ts` khai một project Vitest tên `unit` giữ danh sách
  `include` neo đúng các vị trí trên; script `test` chạy toàn bộ test của app,
  script `test:unit` chạy riêng project `unit` (hiện cùng một tập test vì web
  chỉ có một tầng).

## Chuẩn comment TSDoc (sổ quyết định mục F — chốt 13:14 ngày 26/10/2026)

Mọi code TypeScript/TSX viết mới hoặc sửa trong `apps/web` phải có comment
**tiếng Việt theo chuẩn TSDoc**, chi tiết nhất có thể — flow kỹ thuật phải nằm
ngay trong code, để lần sửa sau dựa vào nội dung code đang có chứ không dựa
vào trí nhớ của trợ lý:

- Đầu mỗi file: khối TSDoc mô tả vai trò của file + flow tổng thể (dữ liệu vào
  từ đâu — loader/dữ liệu route, props, API → các bước xử lý/hiển thị → dữ
  liệu ra và side-effect).
- Mỗi component/hook/hàm trọng yếu: TSDoc `/** ... */` tiếng Việt gồm mục
  đích, `@param`/`@returns` (props của component, giá trị hook trả về), các
  bước flow, bất biến/ràng buộc hiển thị, side-effect (gọi API, điều hướng,
  đăng ký realtime/socket, ghi cache truy vấn).
- Logic hiển thị phức tạp (render theo capability/vai, neo URL + trạng thái
  mở/đóng, gộp dữ liệu nhiều nguồn): comment nội tuyến tiếng Việt nói bước
  flow và **lý do** — không lặp lại điều code đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example` khi cần); định danh và tên
  tag giữ tiếng Anh.
- Sửa code thì căn cứ vào comment flow đang có trong code; thấy comment lệch
  code thật thì sửa comment **trong cùng lượt** với sửa code.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  flow đạt chuẩn là chưa đạt. Code cũ chưa có comment được phủ theo đợt riêng
  của issue #272, không tự trộn việc phủ vào feat đang bay.

## Cấu trúc `features/` và kỷ luật import (issue #500)

Từ đợt tổ chức lại theo mô hình features/, `apps/web` tổ chức theo
feature: mỗi miền nghiệp vụ là một thư mục `src/features/<feature>/` tự
chứa các tầng của chính nó — `routes/` (route module, export trực tiếp
component/loader/clientLoader/meta/ErrorBoundary; config route riêng ở
`features/<feature>/routes.ts` dùng `relative()`/`prefix()` của React
Router), `components/`, `api/` (hàm gọi API thuần, không phụ thuộc
React), `queries/` (hook React Query + query keys riêng của feature ở
`queries/keys.ts` + prefetch/clientLoader), `types/`, `utils/`,
`hooks/`. Mô hình `src/lib/*-data.ts` phẳng đã bỏ: tầng dữ liệu của mỗi
miền nằm trong feature của nó, tách rõ tầng `api/` khỏi tầng
`queries/`.

- **Kỷ luật phụ thuộc một chiều:** thư mục dùng chung ← features ← app.
  Feature chỉ import từ tầng dùng chung (`src/lib/`, `src/components/`,
  `src/hooks/`, `src/config/`, `src/utils/`) và từ chính feature của nó;
  **không import ngang giữa các feature**. Phần hai feature cùng cần
  phải đưa xuống thư mục dùng chung hoặc hợp nhất ở tầng app. Tầng app
  (`src/app/`) import từ mọi feature (file `src/app/routes.ts` chỉ gộp
  các khối route của feature vào layout chung).
- Phần thật sự đa-feature mới ở lại tầng dùng chung: `src/lib/` giữ
  client API (`api.ts`), auth (`auth.tsx`, `auth-client.ts`), phân
  quyền hiển thị (`permissions.tsx`, `access.ts`), `query-keys.ts`
  (chỉ các khoá dùng chung/đa-feature), `curriculum.ts`,
  `course-cards.ts`, `ssr-data.ts`, `tenants.ts`… — không thêm module
  dữ liệu theo miền mới vào `src/lib/`.
- Alias đường dẫn: `#features/*` trỏ `src/features/*`, `#lib/*`,
  `#components/*`, `#hooks/*`, `#config/*`, `#utils/*`, `#test/*` trỏ
  các thư mục dùng chung tương ứng (khai ở `package.json` mục
  `imports` và `tsconfig.json` mục `paths`).

### Ngoại lệ của kỷ luật import ngang — tập cạnh đóng băng

Kỷ luật ở trên có đúng một ngoại lệ: tập cạnh import ngang giữa các
feature đã đóng băng trong [comment phán quyết của điều phối trên
issue #500](https://github.com/kvu90/lms/issues/500#issuecomment-6504346634)
(27 cặp ở code chạy thật và các cặp chỉ có ở file spec, đúng danh sách
trong comment đó — các cạnh này là hệ quả của bảng ánh xạ đã duyệt khi
tổ chức lại `features/`). Mọi cạnh import ngang phát sinh **ngoài** tập
đóng băng đều là khuyết tật phải sửa; không tự ý thêm cạnh vào tập
ngoại lệ — muốn mở rộng phải có phán quyết ghi lại trong issue.

## Bản đồ flow của package

- **Điểm vào:** `src/app/entry.client.tsx` (hydrate phía client) và
  `src/app/entry.server.tsx` (render SSR cho bề mặt public) của React
  Router framework mode; `src/app/root.tsx` là vỏ gốc (sidebar, phiên
  đăng nhập, thông báo); `src/app/routes.ts` chỉ gộp các khối route do
  từng feature khai trong `src/features/<feature>/routes.ts` theo
  chuẩn đường dẫn của sổ mục F; `src/config/i18n.ts` nạp bản dịch.
- **Luồng hiển thị:** điều hướng vào route → root/vỏ đọc phiên (cookie
  `lms_session`) và capabilities từ API → route module trong
  `src/features/<feature>/routes/` nạp dữ liệu qua tầng `queries/` của
  chính feature đó (hook React Query, prefetch/clientLoader) trên nền
  các hàm gọi API thuần ở tầng `api/` và client dùng chung
  `src/lib/api.ts` → render bằng component nền của `@lms/ui` và editor
  của `@lms/editor` (không tự chế editor/component nền riêng) → hành
  động của người dùng gọi API `/api/v1` hoặc kênh realtime
  (`src/features/messaging/api/messaging-socket.ts`,
  `src/features/notifications/hooks/notification-unread-stream.ts`)
  rồi cập nhật cache/dữ liệu hiển thị.
- **Thư mục chính:** `src/features/` — 27 feature theo miền nghiệp vụ
  (khoá học, lớp, câu hỏi/đề/ma trận, làm bài, điểm, tin nhắn, quản
  trị…), mỗi feature tự chứa route module, component và tầng dữ liệu
  của nó; `src/app/` — khung framework (điểm vào, root, shell, file
  gộp route); `src/components/` — vỏ dùng chung của app (bọc component
  `@lms/ui` theo luồng GV/HS); `src/lib/` — client API, auth, phân
  quyền hiển thị và helper thật sự đa-feature; `src/config/`,
  `src/hooks/`, `src/utils/` — cấu hình, hook và hàm thuần dùng
  chung; `src/test/` — hạ tầng test của app.
