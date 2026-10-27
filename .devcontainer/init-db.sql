-- Chạy đúng một lần khi volume dữ liệu PostgreSQL được tạo mới
-- (cơ chế docker-entrypoint-initdb.d của image postgres). DB chính
-- `lms` do biến POSTGRES_DB của service db tạo; file này tạo các DB
-- còn lại mà README gốc và cấu hình test của repo yêu cầu:
--   - lms_test: DB test/dev dùng chung theo README gốc;
--   - lms_test_api: DB riêng của suite test API;
--   - lms_test_worker: DB riêng của suite test worker.
-- Hai suite test dùng DB tách riêng để chạy song song không giẫm dữ
-- liệu toàn cục của nhau (xem apps/api/vitest.config.ts và
-- apps/worker/vitest.config.ts).
CREATE DATABASE lms_test;
CREATE DATABASE lms_test_api;
CREATE DATABASE lms_test_worker;
