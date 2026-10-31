/**
 * Điểm vào riêng của schema KHO NGÂN HÀNG HỆ THỐNG (issue #585) — xem
 * `system-bank.schema.ts` để biết vì sao schema này không đi qua barrel
 * `index.ts` (hai database, hai bộ migration tách nhau).
 */
export * from './system-bank.schema';
