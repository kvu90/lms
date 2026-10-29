/**
 * Barrel của package `@lms/enrol` — bề mặt vật chất hoá cohort và
 * các lõi tầng dữ liệu mà nó đi qua (gán vai, tách vai, giới hạn
 * slot, membership tenant, dữ liệu liên quan), dùng chung cho
 * `apps/api` và `apps/worker` trên cùng schema `@lms/db`.
 */
export * from './errors';
export * from './types';
export * from './contexts';
export * from './plan-limits';
export * from './role-separation';
export * from './role-assignment';
export * from './tenant-membership';
export * from './related-data';
export * from './cohort-materialization';
