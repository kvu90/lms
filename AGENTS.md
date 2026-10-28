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

## Chuẩn ngôn ngữ

- **Code viết bằng tiếng Anh:** định danh, tên hàm/biến/lớp và các
  chuỗi kỹ thuật (log key, mã lỗi, khoá cấu hình, thông điệp do máy
  đọc) viết bằng tiếng Anh.
- **Comment trong code viết bằng tiếng Việt:** toàn bộ comment trong
  code — gồm comment mô tả luồng nghiệp vụ — viết bằng tiếng Việt.
- **Tài liệu và văn bản GitHub viết bằng tiếng Việt:** mọi tài liệu
  trong repo (README, các file AGENTS, tài liệu của package) và mọi
  văn bản trên GitHub (issue, PR, comment) viết bằng tiếng Việt, văn
  phong kỹ thuật trung tính.
- **Sửa code phải cập nhật comment khớp code:** khi sửa code, comment
  tiếng Việt liên quan phải được cập nhật khớp với code trong cùng
  lượt thay đổi; comment lệch code thật là lỗi phải sửa trong cùng
  lượt, không để tồn đọng.

## Chuẩn Issue và PR — văn bản tự chứa

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

## Quy trình tạo Issue và PR

### Flow nhánh dev và main

Flow này có hiệu lực từ khi nhánh `dev` được thiết lập trong đợt tái
cấu trúc repo; trước thời điểm đó, mọi PR vẫn mở vào `main` như quy
trình hiện tại trong tài liệu này.

1. **Hai nhánh dài hạn.** `dev` là nhánh tích hợp và là default
   branch của repo. `main` là nhánh production.
2. **Việc thường theo issue.** Mỗi issue mở một branch từ `dev` (đặt
   tên theo quy ước hiện hành của repo: `feat/<slug>`, `docs/<slug>`,
   `ci/<slug>`), đúng một PR vào `dev` cho mỗi issue theo luật 1
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
   PR cho một issue.

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

### Review và merge

1. Đội thi công không tự merge và không tự đóng issue của mình; đội
   đánh giá độc lập phán quyết trước.
2. Cổng merge: phán quyết đạt (hoặc đã thoả các điều kiện của phán
   quyết) + PR đã rời trạng thái draft. Riêng PR vào `main` (phát
   hành và hotfix) phải có thêm CI đầy đủ — job `verify` và job
   `verify-stack` — success trên head cuối của PR.
3. PR của issue merge kiểu squash; issue tự đóng qua `Closes` trong
   thân PR. PR phát hành `dev → main` merge bằng merge commit theo
   mục "Flow nhánh dev và main" ở trên.

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
   label loại khi tạo issue; label trên issue chỉ là label
   trạng thái theo quy định này.

## Kỷ luật PR liên quan

- Một issue = một feat. Việc phát sinh thuộc cùng feat thì ghi vào đúng
  issue của feat đó (mở lại nếu đã đóng), không xé issue/PR mới.
- 1 issue = 1 PR theo mục "Quy trình tạo Issue và PR" của tài liệu
  này; việc con liệt kê thành task list trong thân PR, không chia
  một issue thành nhiều PR.
- Thân PR mở đầu bằng dòng `**[ĐỘI MUSE — <vai trò>]**`, có mục "Việc
  con", mục "Bản đồ thay đổi theo phạm vi" và mục "Kỷ luật đã giữ".
- Đội thi công không tự merge PR; việc merge chờ đánh giá độc lập.
- CI của repo gồm job `verify` trong `.github/workflows/ci.yml` và
  job `verify-stack` trong `.github/workflows/deploy-check.yml`; kết
  luận về CI chỉ lấy từ log thật của job.
