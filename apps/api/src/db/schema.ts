/**
 * Điểm vào schema duy nhất của apps/api — toàn bộ định nghĩa bảng sống ở
 * package dùng chung `@lms/db` (nguồn sự thật duy nhất cho cả api và
 * worker; xem issue #140 / rà soát #134 mục 11.2). File này chỉ re-export để
 * các import nội bộ `../../db/schema` giữ nguyên một điểm vào.
 */
export * from '@lms/db';
