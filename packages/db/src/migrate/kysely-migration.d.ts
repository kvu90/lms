/**
 * Khai báo kiểu cho đường import con `kysely/migration` của Kysely
 * 0.29.7 (đường import chính thức mà chính package bắt buộc: kiểu
 * `Migrator` ở gốc `kysely` chỉ là lỗi kiểu trỏ sang đường này).
 *
 * Vì sao cần file này: tsconfig dòng Nest của repo dùng
 * `moduleResolution` Node10 nên trình kiểm kiểu không đọc được
 * `exports` map của package `kysely` và không tự tìm thấy kiểu của
 * đường con; runtime Node thì phân giải đúng qua `exports` map
 * (`./migration` → `./dist/migration/index.js`, đã kiểm chứng bằng
 * `require('kysely/migration')`). Khai báo này chỉ dẫn kiểu về
 * đúng file `.d.ts` do chính package phát hành, không tự chế kiểu
 * hay đổi hành vi runtime: mã biên dịch vẫn giữ nguyên chuỗi
 * import `kysely/migration`.
 */
declare module 'kysely/migration' {
  export * from 'kysely/dist/migration/index';
}
