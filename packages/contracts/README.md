# @lms/contracts — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách nghiệp vụ gì

`packages/contracts` là **hợp đồng dữ liệu dùng chung** giữa `apps/api`, `apps/web` và
`apps/worker`: mọi schema Zod mô tả hình dạng request/response của các miền nghiệp vụ
(identity, course, assessment, engagement, platform, site-config, tenants, curriculum,
books, dashboard, guardian, mcp…) chỉ định nghĩa MỘT lần ở đây. Vì cả ba app cùng biên
dịch trên cùng một hợp đồng, một thay đổi hình dạng nghiệp vụ ở đây là thay đổi đồng
thời ở mọi bề mặt — đó là lý do package này mang nhiều quyết định "hình dạng nghiệp
vụ" dù không chứa logic chạy.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Lỗi API theo khuôn **ProblemDetails** dùng chung (một định dạng lỗi duy nhất cho mọi miền, gồm mã lỗi ổn định để client ánh xạ thông điệp). Mã lỗi là một phần của hợp đồng nghiệp vụ: đổi mã = đổi hành vi phía người dùng. Ví dụ đã chốt: vượt trần độ dài tin nhắn trả **400** (không phải 422). | `problem-details.ts`; sổ mục D, issue #212 |
| Khoá site-config là hợp đồng nghiệp vụ cấp site: các ngưỡng/chính sách do ADMIN cài (trần tin nhắn 10.000 ký tự, chính sách loại thông báo được gửi…) khai ở `site-config.ts` — thêm khoá mới phải kèm quyết định nghiệp vụ trong sổ, không tự chế khoá. | `site-config.ts`; sổ mục C/D, chốt 25/10/2026 |
| MCP: tập scope là hợp đồng quyền của AI client — chỉ các scope đã chốt (`lms.questions.read/draft/write`, `lms.banks.contribute`); **không tồn tại scope ghi thẳng vào ngân hàng chung** trong hợp đồng này, vì đường vào bank chung duy nhất là duyệt contribution bởi con người. | `mcp.ts`; sổ mục E; issue #163 |
| Định dạng rich-text dùng chung (`rich-text.ts`) là hợp đồng nội dung soạn thảo giữa `packages/editor`, API và web: nội dung lưu dạng cấu trúc theo schema này, không phải HTML tự do. | `rich-text.ts` |
| Id dùng UUIDv7 (`ids.ts`) thống nhất toàn hệ — id không mang ngữ nghĩa nghiệp vụ (không mã hoá SBD/mã lớp vào id). | `ids.ts`; nền TENANT-0, issue #166 |

## Ranh giới — package này KHÔNG làm gì

- Không chứa logic nghiệp vụ, không truy cập DB, không gác quyền: contracts chỉ mô tả
  HÌNH DẠNG và ràng buộc dữ liệu. Gác quyền/luật nằm ở `apps/api`.
- Không chứa component hay trình bày (đó là `packages/ui`/`packages/editor`/`apps/web`).
- Không định nghĩa schema DB (đó là `packages/db`) — schema API và schema DB
  là hai hợp đồng khác nhau, không suy ra nhau một-một.

## Kỹ thuật tối thiểu

- Nguồn: `src/*.ts`, xuất qua `src/index.ts`; test hợp đồng ở `src/contracts.spec.ts`.
- App tiêu thụ dùng bản `dist` đã build — sửa contracts xong phải build lại trước khi
  typecheck app (dist cũ là nguồn lỗi type giả kinh điển).
