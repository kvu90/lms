# AGENTS.md — Quy định chung cho AI làm việc trong repo này

Tài liệu này chứa các quy định chung áp dụng cho mọi app/package trong
repo. Luật riêng của từng package nằm trong `AGENTS.md` của chính package
đó (`apps/api`, `apps/web`, `apps/worker` và các thư mục trong
`packages/`) và vẫn phải được đọc trước khi sửa package tương ứng.

## Nguồn sự thật

Mọi thông tin cần để hiểu và thi công một việc đều nằm trong repo này
hoặc trong issue đặc tả của chính việc đó trên GitHub:

1. `README.md` ở thư mục gốc — cấu trúc repo, cách chạy, quy ước chung và
   định nghĩa kiểm chứng.
2. `README.md` của package — quyết định nghiệp vụ còn hiệu lực của
   package đó.
3. `AGENTS.md` của package — luật làm việc riêng của package đó.
4. Tài liệu còn giữ trong thư mục `docs/` của repo — gồm các quyết định
   kiến trúc đã được ghi thành văn bản trong repo.
5. Issue đặc tả của việc đang làm — bối cảnh, phạm vi, quyết định liên
   quan (viết trọn vẹn trong issue) và tiêu chí nghiệm thu.

## Quy tắc làm việc chung

- **Bám pattern chính thức của package/framework bên ngoài:** khi
  dùng hay cấu hình bất kỳ package hay framework bên ngoài nào
  (thư viện bên thứ ba, ví dụ Vitest, NestJS, Drizzle hay plugin
  ESLint), đội thi công PHẢI nghiên cứu pattern chính thức của
  chính thư viện đó trước — tài liệu, cách dùng khuyến nghị, bộ
  rule và quy ước của nhà phát hành — và dùng đúng như vậy. Cấm
  đoán hành vi của thư viện hay uốn nó theo thói quen từ nơi khác.
- **Thay đổi tối thiểu theo đúng task:** mọi thay đổi phải là tối
  thiểu cần thiết cho task: không mở rộng phạm vi, không refactor
  tiện tay, không đụng code không liên quan. Phát hiện ngoài phạm
  vi thì ghi lại và báo cáo, không đưa vào thay đổi.

## Chuẩn ngôn ngữ

- **Code viết bằng tiếng Anh:** định danh, tên hàm/biến/lớp và các
  chuỗi kỹ thuật (log key, mã lỗi, khoá cấu hình, thông điệp do máy
  đọc) viết bằng tiếng Anh.
- **Comment trong code viết bằng tiếng Việt:** toàn bộ comment trong
  code — gồm comment mô tả luồng nghiệp vụ — viết bằng tiếng Việt.
- **Mô tả test viết bằng tiếng Việt:** chuỗi mô tả của `describe`,
  `it` và `test` trong các file test viết bằng tiếng Việt; mỗi mô tả
  phải nêu rõ hành vi đang được kiểm chứng — cấm mô tả mơ hồ, không
  nói lên hành vi (ví dụ chỉ ghi tên hàm hoặc "hoạt động đúng").
- **Phân tầng test:** test e2e đi theo quy ước chính thức của
  NestJS — file nằm trong thư mục `test/`, hậu tố `*.e2e-spec.ts`,
  khởi động ứng dụng đầy đủ và kích hoạt qua HTTP bằng supertest.
  Tầng integration là quy định riêng của dự án (NestJS không quy
  ước tầng này): test gọi trực tiếp service là integration test —
  phải đặt tên, vị trí và cách chạy đúng tầng integration, không
  mang danh e2e.
- **Cấu trúc thư mục test:** backend tách test theo tầng —
  `test/e2e/<module>/…` chỉ chứa test e2e (hậu tố `*.e2e-spec.ts`),
  `test/integration/<module>/…` chỉ chứa integration test (hậu tố
  `*.int-spec.ts`); việc chia thư mục con theo module trong mỗi
  tầng và toàn bộ tầng integration là quy định riêng của dự án.
  Test đơn vị (unit) đặt cạnh mã nguồn trong `src`, hậu tố
  `*.spec.ts`, theo quy ước chính thức của NestJS. Ngoại lệ chưa
  chuẩn hoá: worker hiện có 19 file test dạng `*.spec.ts` đặt
  trong thư mục `test/` với nội dung tích hợp và không có spec
  cạnh mã nguồn — trạng thái này đang được xử lý ở một gói riêng,
  không phải cấu trúc đích.
- **Cấu hình chạy test (Vitest):** pattern khám phá mặc định của
  Vitest không nhận cả `.e2e-spec.ts` lẫn `.int-spec.ts`, nên mỗi
  tầng bắt buộc khai `include` tường minh neo đúng thư mục và hậu
  tố của tầng đó trong `projects` của `vitest.config.ts`; quên
  khai là test âm thầm không chạy. Cấm pattern lỏng (ví dụ
  `**/*spec.ts`) và include cả thư mục, vì chúng phá tính tách
  bạch giữa các tầng và có thể làm test chạy trùng. Chạy tách
  theo từng loại bằng `--project` hoặc script riêng (`test:unit`,
  `test:int`, `test:e2e`).
- **Tài liệu và văn bản GitHub viết bằng tiếng Việt:** mọi tài liệu
  trong repo (README, các file AGENTS, tài liệu của package) và mọi
  văn bản trên GitHub (issue, PR, comment) viết bằng tiếng Việt, văn
  phong kỹ thuật trung tính.
- **Sửa code phải cập nhật comment khớp code:** khi sửa code, comment
  tiếng Việt liên quan phải được cập nhật khớp với code trong cùng
  lượt thay đổi; comment lệch code thật là lỗi phải sửa trong cùng
  lượt, không để tồn đọng.

## Quy trình tạo Issue và PR

Chương này là chuẩn GitHub đầy đủ và duy nhất của repo: flow
nhánh, đặt tên branch, tạo issue, tạo PR, chuẩn tiêu đề và
commit, đóng issue, review và merge, vòng đời label. Khi repo
được tạo lại từ đầu, toàn bộ quy trình được dựng lại theo đúng
chương này.

### Flow nhánh dev và main

Flow này có hiệu lực từ khi nhánh `dev` được thiết lập trong đợt tái
cấu trúc repo; trước thời điểm đó, mọi PR vẫn mở vào `main` như quy
trình hiện tại trong tài liệu này.

1. **Hai nhánh dài hạn.** `dev` là nhánh tích hợp và là default
   branch của repo. `main` là nhánh production.
2. **Việc thường theo issue.** Mỗi issue mở một branch từ `dev` (đặt
   tên theo mục "Đặt tên branch" trong tài liệu này), đúng một PR vào `dev` cho mỗi issue theo luật 1
   issue = 1 PR, thân PR có `Closes #<issue>`, squash merge vào
   `dev`. Chuẩn Issue và PR trong tài liệu này (văn bản tự chứa, mẫu
   issue/PR, task list trong thân PR, mục Nghiệm thu) giữ nguyên,
   không đổi.
3. **CI.** PR vào `dev` không chờ CI đầy đủ, và CI đầy đủ không chạy
   theo từng commit/push trên branch của PR vào `dev`. CI đầy đủ —
   job `verify` trong `.github/workflows/ci.yml` và job
   `verify-stack` trong `.github/workflows/deploy-check.yml` — chỉ
   chạy tại PR phát hành `dev → main` và PR hotfix vào `main`; cả
   hai job phải success trên head cuối của các PR đó mới được merge.
4. **Phát hành.** Phát hành bằng PR từ `dev` vào `main`, merge bằng
   merge commit (không squash), cần 1 approval của chủ dự án. Sau
   khi merge, gắn tag phát hành dạng `vYYYY.MM.DD.N` trên `main`
   (`N` là số thứ tự của đợt phát hành trong ngày).
5. **Hotfix.** Việc khẩn cấp trên production mở branch từ `main`, mở
   PR vào `main`, squash merge vào `main`. Sau khi hotfix đã vào
   `main`, bắt buộc mở PR đồng bộ `main → dev` để hai nhánh không
   lệch nhau.

### Văn bản tự chứa

1. **Issue là bản đặc tả tự chứa.** Mọi issue phải chứa đủ: bối cảnh và
   vấn đề, mục tiêu, phạm vi (làm / không làm), chi tiết việc cần làm,
   quyết định liên quan và mục `## Nghiệm thu` gồm các tiêu chí kiểm
   chứng được. Người đọc chỉ có repo này phải hiểu, thi công và kiểm
   chứng được toàn bộ việc chỉ từ nội dung issue. Tương tự, mọi PR
   phải sao chép từng tiêu chí trong mục Nghiệm thu của issue liên
   kết, ghi cách đáp ứng kèm bằng chứng cụ thể, và ghi rõ kiểm chứng
   đã chạy (lệnh, kết quả, trạng thái CI lấy từ log thật).
2. **Quyết định viết trọn vẹn tại nơi sử dụng.** Khi một issue hoặc PR
   dựa trên một quyết định đã có, nội dung đầy đủ của quyết định đó phải
   được viết lại ngay trong văn bản đang dùng nó, trình bày dưới dạng yêu
   cầu/sự kiện kỹ thuật.
3. **Cấm trích dẫn quyết định mơ hồ.** Không viết các câu dạng "theo
   quyết định đã chốt", "như đã thống nhất", "theo chỉ đạo trước đó"
   hoặc trích kèm mốc thời gian của một cuộc trao đổi/sổ ghi nằm ngoài
   repo thay cho nội dung quyết định.
4. **Cấm dẫn file ngoài repo làm căn cứ.** Không viện dẫn sổ quyết
   định, hồ sơ nghiên cứu, ghi chú hay bất kỳ tệp nào nằm ngoài repo
   này — kể cả khi tệp đó tồn tại trên máy của người viết — làm căn cứ
   cho đặc tả, phạm vi hay tiêu chí nghiệm thu. Tài liệu trong repo
   (README, AGENTS.md, tài liệu trong `docs/`) được dẫn theo đường dẫn
   trong repo như bình thường.
5. **Ngôn ngữ và văn phong.** Code, comment và tài liệu tuân theo
   mục "Chuẩn ngôn ngữ" của tài liệu này: code bằng tiếng Anh;
   comment trong code và mọi tài liệu bằng tiếng Việt. Mọi văn bản
   thuộc codebase — issue, PR, commit, comment, tài liệu — dùng văn
   phong kỹ thuật trung tính. Tuyệt đối không dùng danh xưng hay cách
   xưng hô nội bộ trong văn bản của codebase, và không ghi quyết định
   thuộc về cá nhân nào — quyết định luôn được trình bày là yêu cầu
   kỹ thuật.
6. **Mẫu là cơ chế thực thi chuẩn.** Issue mở qua một mẫu trong
   `.github/ISSUE_TEMPLATE/`; PR mở theo
   `.github/pull_request_template.md`. Issue trống (không theo mẫu) bị
   tắt có chủ đích trong `.github/ISSUE_TEMPLATE/config.yml` để mọi
   issue đều đi qua một mẫu có đủ các mục bắt buộc.

### Đặt tên branch

1. Mỗi issue mở một branch riêng từ nhánh tích hợp (`dev`; trong
   giai đoạn chuyển tiếp chưa có `dev` thì từ `main`).
2. Tên branch theo mẫu `<type>/<số issue>-<slug>`: `type` thuộc
   nhóm type của Conventional Commits (`feat`, `fix`, `docs`,
   `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
   `revert`); `slug` là cụm tiếng Anh dạng kebab-case, ngắn, mô
   tả việc. Ví dụ: `fix/442-tenant-api-prefix`.
3. Branch hotfix mở từ `main`, đặt tên `hotfix/<số issue>-<slug>`.
4. Branch đồng bộ sau hotfix (PR `main → dev`) đặt tên cố định
   `sync/main-to-dev`.

### Tạo Issue

1. Dùng Issue template của repo (mẫu tính năng/nghiệp vụ hoặc mẫu báo
   lỗi trong `.github/ISSUE_TEMPLATE/`); issue trống bị tắt, không mở
   issue ngoài mẫu.
2. Thân issue tự chứa đầy đủ: bối cảnh và vấn đề; mục tiêu; phạm vi
   (làm / không làm); chi tiết việc cần làm kèm task list các việc con
   ngay trong issue; quyết định liên quan viết lại trọn vẹn; mục
   `## Nghiệm thu` dạng checklist kiểm chứng được; phụ thuộc và thứ
   tự.
3. Một issue là một đơn vị việc mạch lạc. Việc quá lớn cho một PR thì
   tách thành nhiều issue (mỗi issue một PR), không tách thành nhiều
   PR cho một issue. Khi tách, các issue con (child issue) phải được
   gắn vào issue cha bằng tính năng sub-issues native của GitHub
   ngay khi tạo — cấm chỉ nhắc tới nhau bằng chữ trong thân issue.
   Việc con nằm gọn trong một issue thì theo dõi bằng task list
   trong thân issue và thân PR, không tách thành issue riêng.
4. **Nhãn khi tạo issue.** Khi tạo issue, gắn label loại (`tính năng`
   cho việc tính năng hoặc nghiệp vụ, `lỗi` cho việc báo lỗi) theo
   đặc tả bộ label ở mục "Label trạng thái của issue"; khi bắt đầu
   làm issue, gắn thêm label trạng thái `đang thi công`.
5. **Một issue = một feat.** Việc phát sinh thuộc cùng feat thì ghi
   vào đúng issue của feat đó (mở lại nếu đã đóng), không xé
   issue/PR mới.

### Chuẩn tiêu đề

1. **Tiêu đề issue.** Tối đa khoảng 70 ký tự, theo cấu trúc: động
   từ + đối tượng + tối đa một cụm phân biệt ngắn. Không liệt kê
   phạm vi trong tiêu đề và không chất chi tiết vào tiêu đề —
   toàn bộ chi tiết thuộc về thân issue.
2. **Tiêu đề PR.** Mang mẫu Conventional Commits theo mục "Chuẩn
   commit" ngay dưới đây, vì khi squash merge, tiêu đề PR trở
   thành thông điệp commit trên nhánh chính. Tiêu đề PR cũng nằm
   trong trần khoảng 70 ký tự.

### Chuẩn commit

1. Mọi thông điệp commit tuân theo Conventional Commits 1.0.0,
   dạng `type(scope): mô tả`.
2. `type` thuộc nhóm: `feat`, `fix`, `docs`, `style`,
   `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
3. `scope` là tên module hoặc package ngắn, viết bằng tiếng Anh.
4. Phần mô tả viết bằng tiếng Việt, ngắn gọn; toàn bộ dòng
   subject tối đa khoảng 72 ký tự.
5. Thay đổi phá vỡ tương thích ghi `type(scope)!:` và thêm
   footer `BREAKING CHANGE:` ở thân commit. Phần thân commit
   (khi cần) viết bằng tiếng Việt.

### Tạo PR

1. Một nhánh từ `dev` cho mỗi issue, mở đúng một PR vào `dev` cho
   mỗi issue (theo mục "Flow nhánh dev và main" ở trên; trong giai
   đoạn chuyển tiếp chưa có nhánh `dev` thì nhánh từ `main`, PR vào
   `main`).
2. Thân PR theo `.github/pull_request_template.md`, gồm: `Closes
   #<số issue>`; tóm tắt thay đổi; bản đồ thay đổi theo phạm vi; task
   list toàn bộ việc con của issue (mang từ issue sang) và tích khi
   xong từng mục; đối chiếu nghiệm thu từng tiêu chí kèm bằng chứng;
   kết quả kiểm chứng và CI.
3. Toàn bộ việc con nằm trong PR duy nhất này (nhiều commit là bình
   thường). Tuyệt đối không mở PR thứ hai cho cùng một issue. Nếu PR
   có nguy cơ quá lớn tới mức không đánh giá nổi thì dừng và báo điều
   phối — việc chia là ngoại lệ hiếm, phải được duyệt trước, giữ số
   PR ở mức tối thiểu và vẫn theo dõi bằng task list trong issue.
4. Thân PR có đủ các mục "Việc con", "Bản đồ thay đổi theo phạm vi"
   và "Kỷ luật đã giữ" theo mẫu PR của repo, mở đầu bằng mục "Liên
   kết issue". Dòng `Closes #<số issue>` ở các điểm trên là bắt buộc
   — đây là cơ chế duy nhất để đóng issue, theo mục "Đóng issue"
   trong tài liệu này.

### Review và merge

1. Đội thi công không tự merge và không tự đóng issue của mình; đội
   đánh giá độc lập phán quyết trước.
2. Cổng merge gồm đủ: phán quyết đạt (hoặc đã thoả các điều kiện
   của phán quyết) + CI success trên head cuối theo phạm vi CI của
   loại PR đó (PR vào `main` — phát hành và hotfix — phải có CI đầy
   đủ: job `verify` và job `verify-stack` success trên head cuối) +
   PR đã rời trạng thái draft + mergeable sạch. Mergeable phải được
   kiểm lại ngay trước lệnh merge, vì số liệu ở lần đọc trước có
   thể đã cũ.
3. PR của issue merge kiểu squash; issue tự đóng qua `Closes` trong
   thân PR. PR phát hành `dev → main` merge bằng merge commit theo
   mục "Flow nhánh dev và main" ở trên.
4. Ở từng chặng (bắt đầu thi công, bắt đầu review, có phán quyết,
   merge xong), label trạng thái của issue được đổi theo mục "Label
   trạng thái của issue" trong tài liệu này.
5. **Cổng review hai lớp.** Sau khi đội thi công đẩy PR, PR phải
   qua hai lớp review độc lập trước khi merge: lớp thứ nhất là
   đội review độc lập nội bộ chấm PR tại nguồn; lớp thứ hai là
   lớp review độc lập qua tài khoản ChatGPT của chủ repo, thực
   hiện trên chính PR, chỉ ở chế độ chat thường — cấm dùng các
   chế độ tốn quota như Agent, Deep Research hay Work. Điều
   phối chỉ nêu số PR và repo trong cuộc trò chuyện ChatGPT;
   ChatGPT tự đọc PR qua kết nối GitHub của tài khoản và đăng
   phán quyết của mình thành comment trên chính PR. Phán quyết
   của lớp ChatGPT là comment thường, không phải trạng thái
   review chính thức, vì tài khoản kết nối chính là tác giả
   của PR và GitHub không cho tác giả nộp đánh giá Approve hay
   Request changes lên PR của chính mình. Ở lượt
   đầu, hai lớp chấm độc lập và không bên nào thấy phán quyết
   của bên kia; phán quyết lượt đầu của đội review nội bộ được
   niêm phong trên PR, ghi kèm head SHA của PR, trước khi lớp
   ChatGPT bắt đầu chấm. Sau khi cả hai lớp đã có phán quyết
   lượt đầu, hai lớp đọc comment của nhau trên PR và đánh giá
   qua lại tới đồng thuận. Lượt review qua ChatGPT luôn dùng
   mức reasoning High; sau khi gửi yêu cầu review phải kiểm
   tra lại mức reasoning đang hiệu lực trong chính cuộc trò
   chuyện đó, vì ChatGPT đặt mặc định Medium ở mỗi cuộc trò
   chuyện mới và mức đã chọn có thể không giữ — phán quyết của
   lớp ChatGPT chỉ được tính khi đã kiểm chứng mức High đang
   hiệu lực. Mỗi PR chỉ dùng đúng một cuộc trò chuyện ChatGPT;
   nếu phát hiện mức reasoning bị trượt về Medium, phải sửa
   ngay trên chính cuộc trò chuyện đó (chỉnh mức reasoning rồi
   yêu cầu làm lại review tại đó), không mở cuộc trò chuyện
   mới để hỏi lại. Phán quyết đạt ở điểm 2 của mục này là sự
   đồng thuận đạt của cả hai lớp trên đúng head SHA cuối của
   PR, thể hiện trên PR: chỉ khi cả hai lớp cùng đồng thuận
   đạt trên head đó, PR mới chuyển sang trạng thái `chờ merge`
   và merge theo điểm 2. Mỗi commit mới đẩy lên PR làm cả hai
   phán quyết hết hiệu lực, hai lớp phải chấm lại phần thay
   đổi. Mọi finding chặn (mức nghiêm trọng cao) phải về một
   trạng thái cuối: đã sửa và được bên nêu kiểm chứng lại;
   hoặc bên nêu tự rút kèm bằng chứng; hoặc chủ repo phân xử
   bằng văn bản trên PR — im lặng không tính là đồng thuận.
   Nếu có điểm chưa đạt từ bất kỳ lớp nào, điều phối cử đội
   thi công sửa theo các điểm đã nêu trên PR và cả hai lớp
   chấm lại sau khi sửa. Khi việc của một PR kết thúc, cuộc
   trò chuyện ChatGPT dùng để review PR đó phải được xoá. Lớp
   ChatGPT là review độc lập bên ngoài, không thay thế kiểm
   chứng tại nguồn của đội review nội bộ.
6. **Review hậu merge.** Ngay sau khi một PR được merge, điều
   phối cử thêm một đội review độc lập nữa — khác cả đội thi
   công lẫn đội review nội bộ của PR đó — chấm lại thay đổi
   đã vào `main` tại nguồn trong điều kiện chấm mù (chưa xem
   phán quyết của hai lớp), sau đó mới đối chiếu với các
   comment của hai lớp trên PR và phân loại từng lỗi: cả hai
   lớp cùng bắt được; chỉ lớp nội bộ bắt được; chỉ lớp
   ChatGPT bắt được; chỉ đội hậu merge bắt được (lỗi lọt cả
   hai lớp). Nếu có lỗi lọt cả hai lớp, việc sửa mở theo đúng
   flow hai lớp như một PR thường. Kết quả đối chiếu được báo
   cáo lại theo chỉ dẫn của điều phối từng lượt: đăng comment
   lên PR đã merge hoặc ghi vào issue liên quan.

### Đóng issue

1. Issue chỉ đóng bằng cơ chế tự đóng qua dòng `Closes #<số
   issue>` trong thân PR khi PR merge. Cấm đóng tay issue trước
   khi PR của nó merge.
2. Sau khi merge, phải kiểm chứng issue đã thật sự đóng. Nếu PR
   đã merge mà issue chưa đóng (sai từ khoá đóng hoặc sai nhánh
   đích), đóng issue kèm comment dẫn tới commit merge.
3. Issue cha chỉ đóng khi child issue cuối cùng về đích: PR
   cuối cùng ghi `Closes` cả child issue của nó lẫn issue cha.

### Label trạng thái của issue

1. Mọi issue đang mở mang đúng MỘT label trạng thái trong bộ
   bốn label dưới đây, và label được đổi ngay khi chặng làm
   việc đổi. Trạng thái của issue đọc từ label, không suy từ
   ghi chú hay comment trong issue.
2. `đang thi công` — đội thi công gắn khi bắt đầu làm issue.
3. `đang review` — đội review gắn khi bắt đầu chấm.
4. `chờ sửa` — đội review gắn khi phán quyết là chưa đạt; đội
   thi công đổi ngược về `đang thi công` khi quay lại sửa.
5. `chờ merge` — đội review gắn khi phán quyết đạt; đội merge
   gỡ label trạng thái khi issue đóng sau khi merge.
6. Các mẫu issue trong `.github/ISSUE_TEMPLATE/` không tự gắn
   label khi tạo issue; label trạng thái do đội phụ trách gắn
   theo vòng đời ở các điểm trên.

#### Đặc tả bộ label của repo

Repo dùng đúng 6 label theo bảng dưới đây. Khi repo được tạo
lại từ đầu, tạo đúng 6 label này (qua trang Labels của repo
hoặc qua API) TRƯỚC khi mở issue đầu tiên; xoá các label mặc
định tiếng Anh của GitHub không thuộc bộ này, không dùng bộ
label mặc định đó.

| Tên label | Mã màu | Mô tả | Khi nào gắn | Ai gắn |
| --- | --- | --- | --- | --- |
| `đang thi công` | `1d76db` | Đội thi công đang làm | Khi bắt đầu làm issue | Đội thi công |
| `đang review` | `5319e7` | Đội review độc lập đang chấm | Khi bắt đầu chấm | Đội review |
| `chờ sửa` | `d93f0b` | Review chưa đạt, chờ đội thi công sửa | Khi phán quyết chưa đạt | Đội review |
| `chờ merge` | `0e8a16` | Review đã đạt, chờ merge | Khi phán quyết đạt | Đội review |
| `lỗi` | `d73a4a` | Có gì đó không hoạt động | Label loại cho issue lỗi | Đội mở issue |
| `tính năng` | `a2eeef` | Tính năng mới hoặc yêu cầu | Label loại cho issue tính năng | Đội mở issue |
