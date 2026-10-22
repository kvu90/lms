import { z } from 'zod';

/** P3 Assessment contracts — the single shape source between api and web for grades & questions. */

export const AGGREGATIONS = [
  'natural', 'mean', 'weightedmean', 'simpleweightedmean', 'median', 'lowest', 'highest', 'mode', 'sum',
] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const gradeCategorySchema = z.object({
  id: z.number().int(),
  courseid: z.number().int(),
  parent: z.number().int().nullable(),
  fullname: z.string(),
  aggregation: z.string(),
  droplow: z.number().int(),
  keephigh: z.number().int(),
  aggregateonlygraded: z.boolean(),
  depth: z.number().int(),
  path: z.string(),
  hidden: z.boolean(),
});
export type GradeCategory = z.infer<typeof gradeCategorySchema>;

export const gradeItemSchema = z.object({
  id: z.number().int(),
  courseid: z.number().int(),
  categoryid: z.number().int().nullable(),
  itemname: z.string(),
  itemtype: z.string(),
  itemmodule: z.string().nullable(),
  iteminstance: z.number().int(),
  grademax: z.number(),
  grademin: z.number(),
  gradepass: z.number(),
  weightoverride: z.boolean(),
  aggregationcoef: z.number(),
  extracredit: z.boolean(),
  multiplicator: z.number(),
  plusfactor: z.number(),
  hidden: z.boolean(),
  locked: z.boolean(),
});
export type GradeItem = z.infer<typeof gradeItemSchema>;

export const gradeGradeSchema = z.object({
  id: z.number().int(),
  itemid: z.number().int(),
  userid: z.number().int(),
  rawgrade: z.number().nullable(),
  finalgrade: z.number().nullable(),
  hidden: z.boolean(),
  locked: z.boolean(),
  overridden: z.boolean(),
  excluded: z.boolean(),
  frozen: z.boolean(),
  feedback: z.string().nullable(),
  aggregationweight: z.number().nullable(),
  letter: z.string().nullable(),
});
export type GradeGrade = z.infer<typeof gradeGradeSchema>;

export const gradebookItemViewSchema = z.object({
  item: gradeItemSchema,
  grade: gradeGradeSchema.nullable(),
});
export type GradebookItemView = z.infer<typeof gradebookItemViewSchema>;

export interface GradebookCategoryView {
  category: GradeCategory;
  total: GradebookItemView | null;
  items: GradebookItemView[];
  children: GradebookCategoryView[];
}
export const gradebookCategoryViewSchema: z.ZodType<GradebookCategoryView> = z.object({
  category: gradeCategorySchema,
  total: gradebookItemViewSchema.nullable(),
  items: z.array(gradebookItemViewSchema),
  children: z.lazy(() => z.array(gradebookCategoryViewSchema)),
});
export const gradebookSchema = z.object({
  courseId: z.number().int(),
  userId: z.number().int(),
  categories: z.array(gradebookCategoryViewSchema),
  courseTotal: gradebookItemViewSchema.nullable(),
});
export type Gradebook = z.infer<typeof gradebookSchema>;

export const gradeLetterSchema = z.object({
  id: z.number().int(),
  contextid: z.number().int(),
  lowerboundary: z.number(),
  letter: z.string(),
});
export type GradeLetter = z.infer<typeof gradeLetterSchema>;

export const gradeReportSchema = z.object({
  courseId: z.number().int(),
  rows: z.array(z.object({
    userId: z.number().int(),
    finalgrade: z.number().nullable(),
    letter: z.string().nullable(),
  })),
});
export type GradeReport = z.infer<typeof gradeReportSchema>;

// --- Questions ---------------------------------------------------------------

export const questionCategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  contextid: z.number().int(),
  info: z.string(),
  parent: z.number().int().nullable(),
});
export type QuestionCategory = z.infer<typeof questionCategorySchema>;

export const questionVersionSchema = z.object({
  id: z.number().int(),
  questionbankentryid: z.number().int(),
  questionid: z.number().int(),
  version: z.number().int(),
  questiontext: z.string(),
  defaultmark: z.number(),
  answerdata: z.record(z.string(), z.unknown()),
});
export type QuestionVersion = z.infer<typeof questionVersionSchema>;

export const questionViewSchema = z.object({
  question: z.object({
    id: z.number().int(),
    category: z.number().int(),
    qtype: z.string(),
    name: z.string(),
  }),
  entry: z.object({
    id: z.number().int(),
    questioncategoryid: z.number().int(),
    questionid: z.number().int(),
    latestversion: z.number().int(),
  }),
  latestVersion: questionVersionSchema,
});
export type QuestionView = z.infer<typeof questionViewSchema>;

export const QUESTION_STATES = [
  'notstarted', 'todo', 'incomplete', 'complete',
  'gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'finished',
] as const;

export const questionAttemptSchema = z.object({
  id: z.number().int(),
  questionusageid: z.number().int(),
  slot: z.number().int(),
  behaviour: z.string(),
  questionid: z.number().int(),
  questionversionid: z.number().int().nullable(),
  maxmark: z.number(),
  state: z.string(),
  fraction: z.number().nullable(),
  steps: z.array(z.object({
    id: z.number().int(),
    sequencenumber: z.number().int(),
    state: z.string(),
    fraction: z.number().nullable(),
    data: z.record(z.string(), z.string().nullable()),
  })),
});
export type QuestionAttempt = z.infer<typeof questionAttemptSchema>;

export const questionUsageSchema = z.object({
  usage: z.object({
    id: z.number().int(),
    component: z.string(),
    instanceid: z.number().int(),
    preferredbehaviour: z.string(),
  }),
  state: z.string(),
  attempts: z.array(questionAttemptSchema),
});
export type QuestionUsage = z.infer<typeof questionUsageSchema>;
