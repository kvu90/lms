/**
 * Hình dạng dòng trong ARCHIVE sao lưu (định dạng `lms-backup` v1) —
 * chuyển Kysely, issue #648.
 *
 * Các interface này là hình dạng camelCase của một dòng dữ kiện khi
 * nằm trong archive (và khi contributor đọc lại để khôi phục): trước
 * đây chúng là `typeof <bảng>.$inferSelect` của schema Drizzle. Khi
 * tầng dữ liệu chuyển sang Kysely, hình dạng archive phải giữ
 * NGUYÊN — archive cũ vẫn khôi phục được và archive mới vẫn mang
 * đúng các khoá camelCase như trước — nên các interface được khai
 * tường minh tại đây, thuộc về chính định dạng archive của module
 * backup. Cột jsonb được khôi phục bằng insert mang kiểu
 * `ArchiveJsonValue` (khớp kiểu `Json` mà codegen sinh cho các cột
 * đó — hình dạng cũ phía Drizzle là `unknown` vì jsonb không khai
 * `$type<>`); các cột jsonb chỉ đọc trong archive giữ `unknown`.
 * `seq`/int8 không xuất hiện trong các bảng này (size_bytes của
 * content bank không thuộc phạm vi contributor của backup).
 */

/** Giá trị JSON thuần trong archive — khớp cấu trúc đệ quy của kiểu `Json` phía codegen. */
export type ArchiveJsonValue =
  | string
  | number
  | boolean
  | null
  | ArchiveJsonValue[]
  | { [key: string]: ArchiveJsonValue | undefined };

/** Một dòng của bảng course trong archive. */
export interface CourseRow {
  id: string;
  tenantId: string;
  category: string;
  fullName: string;
  shortName: string;
  idNumber: string;
  summary: string;
  format: string;
  visible: boolean;
  startDate: Date | null;
  endDate: Date | null;
  groupMode: number;
  groupModeForce: boolean;
  enableCompletion: boolean;
  subjectId: string | null;
  grade: number | null;
  isTemplate: boolean;
  classId: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng course_sections trong archive. */
export interface CourseSectionsRow {
  id: string;
  course: string;
  section: number;
  name: string | null;
  summary: string;
  visible: boolean;
  availability: unknown | null;
  openAt: Date | null;
  updatedAt: Date;
}

/** Một dòng của bảng course_modules trong archive. */
export interface CourseModulesRow {
  id: string;
  course: string;
  section: string;
  component: string;
  instanceId: string | null;
  name: string;
  visible: boolean;
  groupMode: number;
  availability: unknown | null;
  completion: number;
  completionView: boolean;
  completionUseGrade: boolean;
  completionManual: boolean;
  completionExpected: Date | null;
  openAt: Date | null;
  sortOrder: number;
  deletionInProgress: boolean;
  added: Date;
}

/** Một dòng của bảng enrol trong archive. */
export interface EnrolRow {
  id: string;
  courseId: string;
  enrol: string;
  status: number;
  name: string | null;
  roleId: string | null;
  enrolPeriod: number;
  timeStart: Date | null;
  timeEnd: Date | null;
  customInt1: string | null;
  customInt2: string | null;
  customText1: string;
  cost: number;
  currency: string;
  paymentAccountId: string | null;
  enrolmentKey: string | null;
  sendWelcomeMessage: boolean;
  welcomeMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng user_enrolments trong archive. */
export interface UserEnrolmentsRow {
  id: string;
  enrolId: string;
  userId: string;
  status: number;
  timeStart: Date;
  timeEnd: Date | null;
  modifierId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng course_groups trong archive. */
export interface CourseGroupsRow {
  id: string;
  courseId: string;
  name: string;
  idNumber: string;
  description: string;
  enrolmentKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng groups_members trong archive. */
export interface GroupsMembersRow {
  id: string;
  groupId: string;
  userId: string;
  timeAdded: Date;
  component: string;
  itemId: string | null;
}

/** Một dòng của bảng groupings trong archive. */
export interface GroupingsRow {
  id: string;
  courseId: string;
  name: string;
  idNumber: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng groupings_groups trong archive. */
export interface GroupingsGroupsRow {
  groupingId: string;
  groupId: string;
  timeAdded: Date;
}

/** Một dòng của bảng grade_items trong archive. */
export interface GradeItemsRow {
  id: string;
  courseId: string;
  itemName: string;
  itemType: string;
  itemModule: string | null;
  itemInstance: string | null;
  gradeType: string;
  gradeMax: number;
  gradeMin: number;
  gradePass: number;
  idNumber: string | null;
  multiplicator: number;
  plusFactor: number;
  hidden: boolean;
  locked: boolean;
  sortOrder: number;
  postingPolicy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng grade_grades trong archive. */
export interface GradeGradesRow {
  id: string;
  itemId: string;
  userId: string;
  rawGrade: number | null;
  rawGradeMax: number;
  rawGradeMin: number;
  finalGrade: number | null;
  hidden: boolean;
  locked: boolean;
  lockTime: Date | null;
  overridden: boolean;
  excluded: boolean;
  frozen: boolean;
  feedback: string | null;
  information: string | null;
  aggregationStatus: string;
  aggregationWeight: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng course_modules_completion trong archive. */
export interface CourseModulesCompletionRow {
  id: string;
  courseModuleId: string;
  userId: string;
  completionState: number;
  viewed: boolean;
  overrideBy: string | null;
  updatedAt: Date;
}

/** Một dòng của bảng course_completions trong archive. */
export interface CourseCompletionsRow {
  id: string;
  userId: string;
  course: string;
  status: string;
  timeEnrolled: Date;
  timeStarted: Date | null;
  timeCompleted: Date | null;
  reAggregate: Date;
}

/** Một dòng của bảng course_completion_criteria trong archive. */
export interface CourseCompletionCriteriaRow {
  id: string;
  course: string;
  criteriaType: string;
  moduleInstance: string | null;
  date: Date | null;
  courseInstance: string | null;
  enrolPeriodDays: number | null;
  roleId: string | null;
  sortOrder: number;
  createdAt: Date;
}

/** Một dòng của bảng course_completion_crit_compl trong archive. */
export interface CourseCompletionCritComplRow {
  id: string;
  criteriaId: string;
  userId: string;
  markedBy: string | null;
  timeCompleted: Date;
}

/** Một dòng của bảng course_completion_settings trong archive. */
export interface CourseCompletionSettingsRow {
  course: string;
  method: number;
}

/** Một dòng của bảng files trong archive. */
export interface FilesRow {
  id: string;
  contentHash: string;
  contextId: string;
  component: string;
  fileArea: string;
  itemId: string | null;
  filePath: string;
  fileName: string;
  userId: string | null;
  fileSize: number;
  mimeType: string | null;
  status: number;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng question_categories trong archive. */
export interface QuestionCategoriesRow {
  id: string;
  name: string;
  contextId: string;
  bankId: string | null;
  info: string;
  parent: string | null;
  sortOrder: number;
  stamp: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng question trong archive. */
export interface QuestionRow {
  id: string;
  category: string;
  qtype: string;
  createdBy: string | null;
  modifiedBy: string | null;
  derivedFromQuestionId: string | null;
  derivedFromVersionId: string | null;
  derivedFromBankId: string | null;
  originalAuthorId: string | null;
  sourceKind: string | null;
  sourceRef: string | null;
  idnumber: string | null;
  copyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng question_bank_entries trong archive. */
export interface QuestionBankEntriesRow {
  id: string;
  questionCategoryId: string;
  questionId: string;
  latestVersion: number;
  status: string;
  withdrawnReason: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng question_versions trong archive. */
export interface QuestionVersionsRow {
  id: string;
  questionBankEntryId: string;
  questionId: string;
  version: number;
  status: string;
  questionText: ArchiveJsonValue;
  generalFeedback: ArchiveJsonValue | null;
  defaultMark: number;
  penalty: number;
  stimulusId: string | null;
  createdAt: Date;
}

/** Một dòng của bảng stimuli trong archive. */
export interface StimuliRow {
  id: string;
  categoryId: string;
  createdBy: string | null;
  content: ArchiveJsonValue;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng question_answers trong archive. */
export interface QuestionAnswersRow {
  id: string;
  questionVersionId: string;
  answer: ArchiveJsonValue;
  isCorrect: boolean;
  feedback: ArchiveJsonValue | null;
  sortOrder: number;
}

/** Một dòng của bảng question_answer_keys trong archive. */
export interface QuestionAnswerKeysRow {
  id: string;
  questionVersionId: string;
  guidance: ArchiveJsonValue | null;
  solution: ArchiveJsonValue | null;
}

/** Một dòng của bảng qtype_multichoice_options trong archive. */
export interface QtypeMultichoiceOptionsRow {
  id: string;
  questionVersionId: string;
  shuffleAnswers: boolean;
  answerNumbering: string;
  correctFeedback: ArchiveJsonValue | null;
  incorrectFeedback: ArchiveJsonValue | null;
  showStandardInstruction: boolean;
}

/** Một dòng của bảng question_truefalse trong archive. */
export interface QuestionTruefalseRow {
  id: string;
  questionVersionId: string;
  trueAnswer: string;
  falseAnswer: string;
  showStandardInstruction: boolean;
}

/** Một dòng của bảng qtype_shortanswer_options trong archive. */
export interface QtypeShortanswerOptionsRow {
  id: string;
  questionVersionId: string;
  useCase: boolean;
  numericAnswer: boolean;
  numericMaxLength: number | null;
  numericAllowSign: boolean;
  numericAllowDecimal: boolean;
}

/** Một dòng của bảng qtype_essay_options trong archive. */
export interface QtypeEssayOptionsRow {
  id: string;
  questionVersionId: string;
  responseFormat: string;
  responseRequired: boolean;
  responseFieldLines: number;
  minWordLimit: number | null;
  maxWordLimit: number | null;
  graderInfo: ArchiveJsonValue | null;
  responseTemplate: ArchiveJsonValue | null;
}

/** Một dòng của bảng badge trong archive. */
export interface BadgeRow {
  id: string;
  name: string;
  description: string;
  type: number;
  courseId: string | null;
  issuerName: string;
  issuerUrl: string;
  issuerContact: string;
  expireDate: Date | null;
  expirePeriod: number | null;
  status: number;
  version: string;
  language: string;
  userCreated: string | null;
  userModified: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng badge_criteria trong archive. */
export interface BadgeCriteriaRow {
  id: string;
  badgeId: string;
  criteriaType: string;
  method: number;
  params: unknown;
  description: string;
}

/** Một dòng của bảng calendar_events trong archive. */
export interface CalendarEventsRow {
  id: string;
  name: string;
  description: string;
  eventType: string;
  courseId: string | null;
  groupId: string | null;
  categoryId: string | null;
  userId: string | null;
  contextId: string | null;
  subscriptionId: string | null;
  uuid: string | null;
  repeatId: string | null;
  rrule: string | null;
  isException: boolean;
  exceptionOf: string | null;
  timeStart: Date;
  timeDuration: number;
  visible: boolean;
  location: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng của bảng calendar_subscriptions trong archive. */
export interface CalendarSubscriptionsRow {
  id: string;
  name: string;
  url: string | null;
  icsData: string | null;
  eventType: string;
  courseId: string | null;
  categoryId: string | null;
  userId: string | null;
  pollInterval: number;
  lastUpdated: Date | null;
  createdAt: Date;
}
