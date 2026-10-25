# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/contracts`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của contracts.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT;
   tài liệu mới hơn không tự thắng sổ; mâu thuẫn thì DỪNG và báo main chat.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Đổi schema ở đây gần như luôn kéo theo thay đổi ở api/web —
  các thay đổi đó thuộc cùng feat/PR, không tách PR riêng cho contracts.
- Chỉ mô tả hình dạng dữ liệu. Cần logic/ràng buộc chạy → đặt ở `apps/api`.

## Điều cấm package-specific

- Cấm đổi mã lỗi/khuôn ProblemDetails đã chốt (vd vượt trần tin nhắn = 400) theo cảm
  tính — mã lỗi là hợp đồng nghiệp vụ, đổi phải có quyết định trong sổ.
- Cấm thêm scope MCP mới (đặc biệt scope ghi bank chung) khi chưa có quyết định chốt.
- Cấm thêm khoá site-config không có quyết định nghiệp vụ đi kèm.
- Cấm dùng kiểu ngày giờ không biểu diễn được trong JSON Schema ở schema route
  (`z.date()` làm crash boot production qua Swagger) — dùng `z.iso.datetime(...)`.
- Cấm định nghĩa trùng một schema đã có: một miền một file, xuất qua `index.ts`.

## Kiểm chứng bắt buộc

- **Typecheck + build trước khi push**: `pnpm --filter @lms/contracts typecheck`
  rồi build để `dist` mới — sau đó mới typecheck các app tiêu thụ trong cùng feat.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Local chỉ test targeted
  (`contracts.spec`); suite nặng giữ khoá `flock
  ~/workspace/lms-nest-ops/heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Test contracts phải kiểm các ràng buộc NGHIỆP VỤ của hình dạng (giới hạn độ dài,
  enum trạng thái đúng tập đã chốt, scope đúng tập đã chốt), không chỉ kiểm "schema
  parse được JSON mẫu". Nới một ràng buộc nghiệp vụ thì test phải fail.
- Đổi schema mà mọi test vẫn xanh nguyên = dấu hiệu test chưa bám nghiệp vụ — bổ
  sung test bám quyết định trong cùng lượt.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
