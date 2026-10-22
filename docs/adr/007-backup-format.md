# ADR-007: Định dạng backup riêng của LMS

## Quyết định

Backup dùng định dạng archive RIÊNG, có version tường minh:

```json
{ "format": "lms-backup", "version": 1, "courseId": 123, "anonymize": false,
  "sections": [...], "contributors": { "courses": {...}, "enrol": {...}, ... },
  "files": [{ "contenthash": "...", "filename": "...", "dataBase64": "..." }] }
```

Archive được lưu trong cột `archive` (JSONB) của `backup_jobs` và các bước
chạy được ghi ở `backup_job_steps`; ánh xạ id khi restore nằm ở
`backup_id_mappings`.

## Lý do / hệ quả

- KHÔNG dùng `.mbz` và KHÔNG tương thích ngược với Moodle (chủ dự án đã chốt
  22/10/2026: chỉ cần tương đương nghiệp vụ, không giữ tương thích định dạng).
- Restore không bao giờ giữ id gốc: mọi thực thể được tạo mới và map qua
  `backup_id_mappings` theo (job, itemtype, oldid) → newid.
- Ba chế độ restore tường minh: `new` (course mới), `merge` (gộp vào course
  đích, tạo section/cm mới), `replace` (xoá section/cm/enrol/grades/
  completion hiện có của course đích trước khi khôi phục).
- Nâng `version` khi format thay đổi không tương thích; reader chỉ chấp nhận
  version đã biết và từ chối rõ ràng thay vì khôi phục sai lặng lẽ.
