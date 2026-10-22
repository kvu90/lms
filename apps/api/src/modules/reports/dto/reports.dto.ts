import {
  createReportSchema,
  createReportScheduleSchema,
  type CreateReport,
  type CreateReportSchedule,
} from '@lms/contracts';

/** Validation Report Builder dùng Zod qua Standard Schema — schema nền ở `@lms/contracts`. */
export { createReportSchema, createReportScheduleSchema };
export type CreateReportDto = CreateReport;
export type CreateScheduleDto = CreateReportSchedule;
