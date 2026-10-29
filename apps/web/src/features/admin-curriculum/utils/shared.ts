// Khuôn dùng chung của cụm quản trị chương trình (GDPT 2018).

import { ApiError } from '#lib/api';

/** Thông điệp lỗi từ API (problem detail) hoặc thông điệp dự phòng theo i18n. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (err.problem.detail ?? err.problem.title ?? fallback) : fallback;
}
