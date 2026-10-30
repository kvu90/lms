/**
 * Điểm vào riêng của schema CONTROL PLANE (issue #580) — xem
 * `control-plane.schema.ts` để biết vì sao schema này không đi qua
 * barrel `index.ts` (hai database, hai bộ migration tách nhau).
 */
export * from './control-plane.schema';
