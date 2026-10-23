export interface CapabilityDefinition {
  name: string;
  capType: 'read' | 'write';
  contextLevel: number;
  component: string;
  /** Default permission per role archetype, seeded as overrides at the system context. */
  archetypes: Partial<Record<string, number>>;
}
import { CAP_ALLOW } from './permission';

const ALL_STAFF = { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW };

/** Capability registry — definitions live in code (like Moodle db/access.php), rows are synced into `capabilities`. */
export const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  { name: 'moodle/site:config', capType: 'write', contextLevel: 10, component: 'core', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/site:viewuseridentity', capType: 'read', contextLevel: 10, component: 'core', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/user:create', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/user:update', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/user:delete', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/user:viewdetails', capType: 'read', contextLevel: 30, component: 'core_user', archetypes: { ...ALL_STAFF, user: CAP_ALLOW } },
  { name: 'moodle/user:loginas', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/role:manage', capType: 'write', contextLevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/role:assign', capType: 'write', contextLevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/role:override', capType: 'write', contextLevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/course:view', capType: 'read', contextLevel: 50, component: 'core_course', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW, guest: CAP_ALLOW } },
  { name: 'lms/files:view', capType: 'read', contextLevel: 50, component: 'core_files', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'lms/files:upload', capType: 'write', contextLevel: 50, component: 'core_files', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'lms/customfield:manage', capType: 'write', contextLevel: 10, component: 'core_customfield', archetypes: { manager: CAP_ALLOW } },
  // Course & Enrolment
  { name: 'moodle/category:manage', capType: 'write', contextLevel: 40, component: 'core_course', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/course:create', capType: 'write', contextLevel: 40, component: 'core_course', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW } },
  { name: 'moodle/course:update', capType: 'write', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/course:delete', capType: 'write', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/course:viewhiddencourses', capType: 'read', contextLevel: 50, component: 'core_course', archetypes: { ...ALL_STAFF } },
  { name: 'moodle/course:viewhiddenactivities', capType: 'read', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/course:manageactivities', capType: 'write', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/course:managegroups', capType: 'write', contextLevel: 50, component: 'core_group', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/group:accessallgroups', capType: 'read', contextLevel: 50, component: 'core_group', archetypes: { ...ALL_STAFF } },
  { name: 'moodle/cohort:manage', capType: 'write', contextLevel: 10, component: 'core_cohort', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/cohort:view', capType: 'read', contextLevel: 10, component: 'core_cohort', archetypes: { ...ALL_STAFF } },
  { name: 'lms/enrol:manage', capType: 'write', contextLevel: 50, component: 'core_enrol', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/completion:manage', capType: 'write', contextLevel: 50, component: 'core_completion', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/completion:markothers', capType: 'write', contextLevel: 50, component: 'core_completion', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Assessment (Grades / Questions)
  { name: 'moodle/grade:manage', capType: 'write', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/grade:edit', capType: 'write', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/grade:viewall', capType: 'read', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/question:managecategory', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/question:add', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/question:editall', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/question:useall', capType: 'read', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Quiz activity (mod_quiz) — capability tại context của course module như db/access.php của Moodle.
  { name: 'mod/quiz:view', capType: 'read', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW, student: CAP_ALLOW } },
  { name: 'mod/quiz:attempt', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { student: CAP_ALLOW } },
  { name: 'mod/quiz:manage', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'mod/quiz:grade', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'mod/quiz:viewreports', capType: 'read', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'mod/quiz:preview', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Communication & Engagement
  { name: 'moodle/site:sendmessage', capType: 'write', contextLevel: 30, component: 'core_message', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/calendar:manageentries', capType: 'write', contextLevel: 50, component: 'core_calendar', archetypes: { ...ALL_STAFF } },
  { name: 'moodle/calendar:managegroupentries', capType: 'write', contextLevel: 50, component: 'core_calendar', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/calendar:manageownentries', capType: 'write', contextLevel: 30, component: 'core_calendar', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/calendar:managesubscriptions', capType: 'write', contextLevel: 10, component: 'core_calendar', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/badges:createbadge', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/badges:configurecriteria', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/badges:awardbadge', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/badges:revokebadge', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/competency:competencymanage', capType: 'write', contextLevel: 10, component: 'core_competency', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/competency:planmanage', capType: 'write', contextLevel: 30, component: 'core_competency', archetypes: { manager: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/competency:planview', capType: 'read', contextLevel: 30, component: 'core_competency', archetypes: { ...ALL_STAFF, user: CAP_ALLOW } },
  { name: 'moodle/competency:usercompetencyreview', capType: 'write', contextLevel: 10, component: 'core_competency', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/competency:coursecompetencymanage', capType: 'write', contextLevel: 50, component: 'core_competency', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/tag:edit', capType: 'write', contextLevel: 50, component: 'core_tag', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/tag:manage', capType: 'write', contextLevel: 10, component: 'core_tag', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/comment:view', capType: 'read', contextLevel: 50, component: 'core_comment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/comment:post', capType: 'write', contextLevel: 50, component: 'core_comment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/comment:delete', capType: 'write', contextLevel: 50, component: 'core_comment', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/rating:view', capType: 'read', contextLevel: 50, component: 'core_rating', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/rating:viewall', capType: 'read', contextLevel: 50, component: 'core_rating', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/rating:rate', capType: 'write', contextLevel: 50, component: 'core_rating', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/blog:create', capType: 'write', contextLevel: 30, component: 'core_blog', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/blog:view', capType: 'read', contextLevel: 10, component: 'core_blog', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/blog:manageentries', capType: 'write', contextLevel: 30, component: 'core_blog', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/notes:create', capType: 'write', contextLevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/notes:view', capType: 'read', contextLevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/notes:manage', capType: 'write', contextLevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW } },
  // Platform Services
  { name: 'lms/search:use', capType: 'read', contextLevel: 10, component: 'core_search', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/webservice:manage', capType: 'write', contextLevel: 10, component: 'core_webservice', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/webservice:createtoken', capType: 'write', contextLevel: 10, component: 'core_webservice', archetypes: { manager: CAP_ALLOW } },
  { name: 'lms/backup:backupcourse', capType: 'write', contextLevel: 50, component: 'core_backup', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/backup:restorecourse', capType: 'write', contextLevel: 50, component: 'core_backup', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/analytics:viewinsights', capType: 'read', contextLevel: 50, component: 'core_analytics', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/analytics:manage', capType: 'write', contextLevel: 10, component: 'core_analytics', archetypes: { manager: CAP_ALLOW } },
  { name: 'report/log:view', capType: 'read', contextLevel: 50, component: 'report_log', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/reportbuilder:manage', capType: 'write', contextLevel: 10, component: 'core_reportbuilder', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/reportbuilder:view', capType: 'read', contextLevel: 10, component: 'core_reportbuilder', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/contentbank:viewcontent', capType: 'read', contextLevel: 50, component: 'core_contentbank', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'moodle/contentbank:upload', capType: 'write', contextLevel: 50, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/contentbank:editcontent', capType: 'write', contextLevel: 50, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/payment:manageaccounts', capType: 'write', contextLevel: 10, component: 'core_payment', archetypes: { manager: CAP_ALLOW } },
  { name: 'lms/payment:pay', capType: 'write', contextLevel: 10, component: 'core_payment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/privacy:request', capType: 'write', contextLevel: 30, component: 'core_privacy', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/privacy:manage', capType: 'write', contextLevel: 10, component: 'core_privacy', archetypes: { manager: CAP_ALLOW } },
];

export const CONTEXT_LEVELS = { SYSTEM: 10, USER: 30, COURSECAT: 40, COURSE: 50, MODULE: 70, BLOCK: 80 } as const;

export interface RoleDefinition { shortName: string; name: string; archetype: string; sortOrder: number }
export const DEFAULT_ROLES: RoleDefinition[] = [
  { shortName: 'manager', name: 'Manager', archetype: 'manager', sortOrder: 1 },
  { shortName: 'coursecreator', name: 'Course creator', archetype: 'coursecreator', sortOrder: 2 },
  { shortName: 'editingteacher', name: 'Teacher', archetype: 'editingteacher', sortOrder: 3 },
  { shortName: 'teacher', name: 'Non-editing teacher', archetype: 'teacher', sortOrder: 4 },
  { shortName: 'student', name: 'Student', archetype: 'student', sortOrder: 5 },
  { shortName: 'guest', name: 'Guest', archetype: 'guest', sortOrder: 6 },
  { shortName: 'user', name: 'Authenticated user', archetype: 'user', sortOrder: 7 },
];
