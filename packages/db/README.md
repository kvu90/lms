# @lms/db — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách nghiệp vụ gì

`packages/db` là **định nghĩa schema cơ sở dữ liệu dùng chung duy nhất** của hệ
thống (Drizzle): toàn bộ bảng của mọi miền nghiệp vụ (access, courses, questions, quiz,
grades, messaging, payments, tenants, books, curriculum…) khai ở đây, để `apps/api` và
`apps/worker` đọc/ghi trên **cùng một mô hình dữ liệu** — không còn bản sao schema
riêng theo từng app (việc hợp nhất này là lý do package tồn tại). Hình dạng bảng ở đây
quyết định những sự thật nghiệp vụ nào được lưu bền: trạng thái công bố điểm, quan hệ
lớp–khoá, tenant của mọi bản ghi, vết audit.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Multi-tenant bằng shared DB: mọi bảng nghiệp vụ mang `tenant_id` và được PostgreSQL **RLS ép fail-closed** (policy theo GUC `app.tenant_id`; thiếu ngữ cảnh tenant = không thấy dữ liệu). Tenant = TRUNG TÂM; trang chính là tenant nền tảng. | Sổ mục A; issue #166, TENANT-0 |
| Khoá chính mặc định **UUIDv7** cho các bảng nghiệp vụ (trừ ngoại lệ đã chốt, vd bảng OAuth của Better Auth). Số lượng bảng/số mặc định uuidv7/số policy RLS là bất biến được spec ở apps/api khoá cứng — thay đổi schema phải cập nhật các đếm đó bằng con số đếm thật trên baseline cuối. | Nền uuidv7 toàn hệ; spec `uuidv7-primary-keys-flow` |
| Lớp–khoá: một khoá thuộc đúng một lớp (`course.class_id`); roster lớp nằm ở cohort đi kèm lớp (không bảng roster riêng) — schema phải giữ quan hệ này, không tạo đường ghi danh song song thứ hai. | Sổ mục A; issue #184 |
| Dữ liệu chuẩn GDPT neo bằng UUIDv5 theo khoá tự nhiên; 4 FK từ dữ liệu chuẩn dùng `restrict` (không cascade) để import diff không xoá được dữ liệu đã neo. | Phương án D, chốt 25/10/2026; issue #161 |
| Dự án xây từ đầu: **reset dữ liệu thoải mái tới khi chốt version** — schema tiến hoá bằng baseline mới, không thiết kế migration giữ dữ liệu live. | Sổ mục F, chốt 23/10/2026 |
| Hai dòng tiền tách bạch trong schema thanh toán: bản ghi thanh toán gắn tenant sở hữu và tài khoản nhận của chính chủ sở hữu; platform không thu hộ học phí trung tâm. | Sổ mục E; issue #189 |

## Ranh giới — package này KHÔNG làm gì

- Không chứa logic nghiệp vụ, query nghiệp vụ hay gác quyền theo capability: schema
  chỉ định nghĩa bảng/cột/khoá/chỉ mục/policy nền. Luật chạy nằm ở `apps/api`.
- Không chứa file migration/baseline: baseline Drizzle nằm ở `apps/api/drizzle`
  (package này là nguồn định nghĩa để sinh baseline đó).
- Không phải hợp đồng API: hình dạng request/response thuộc `packages/contracts`.

## Kỹ thuật tối thiểu

- Nguồn theo miền: `src/<miền>.schema.ts`, hạ tầng chung ở
  `src/infrastructure.schema.ts`, xuất qua `src/index.ts`.
- App tiêu thụ dùng bản `dist` — sửa schema xong phải build lại package trước khi
  typecheck/migrate ở app (dist cũ = lỗi giả kinh điển).
