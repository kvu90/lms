export interface CapabilityDefinition {
  name: string;
  captype: 'read' | 'write';
  contextlevel: number;
  component: string;
  /** Default permission per role archetype, seeded as overrides at the system context. */
  archetypes: Partial<Record<string, number>>;
}
import { CAP_ALLOW } from './permission';

const ALL_STAFF = { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW };

/** Capability registry — definitions live in code (like Moodle db/access.php), rows are synced into `capabilities`. */
export const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  { name: 'moodle/site:config', captype: 'write', contextlevel: 10, component: 'core', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/site:viewuseridentity', captype: 'read', contextlevel: 10, component: 'core', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/user:create', captype: 'write', contextlevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/user:update', captype: 'write', contextlevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/user:delete', captype: 'write', contextlevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/user:viewdetails', captype: 'read', contextlevel: 30, component: 'core_user', archetypes: { ...ALL_STAFF, user: CAP_ALLOW } },
  { name: 'moodle/user:loginas', captype: 'write', contextlevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/role:manage', captype: 'write', contextlevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/role:assign', captype: 'write', contextlevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/role:override', captype: 'write', contextlevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/course:view', captype: 'read', contextlevel: 50, component: 'core_course', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW, guest: CAP_ALLOW } },
  { name: 'lms/files:view', captype: 'read', contextlevel: 50, component: 'core_files', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'lms/files:upload', captype: 'write', contextlevel: 50, component: 'core_files', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'lms/customfield:manage', captype: 'write', contextlevel: 10, component: 'core_customfield', archetypes: { manager: CAP_ALLOW } },
  // P2 — Course & Enrolment
  { name: 'moodle/category:manage', captype: 'write', contextlevel: 40, component: 'core_course', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/course:create', captype: 'write', contextlevel: 40, component: 'core_course', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW } },
  { name: 'moodle/course:update', captype: 'write', contextlevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/course:delete', captype: 'write', contextlevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/course:viewhiddencourses', captype: 'read', contextlevel: 50, component: 'core_course', archetypes: { ...ALL_STAFF } },
  { name: 'moodle/course:viewhiddenactivities', captype: 'read', contextlevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/course:manageactivities', captype: 'write', contextlevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/course:managegroups', captype: 'write', contextlevel: 50, component: 'core_group', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/group:accessallgroups', captype: 'read', contextlevel: 50, component: 'core_group', archetypes: { ...ALL_STAFF } },
  { name: 'moodle/cohort:manage', captype: 'write', contextlevel: 10, component: 'core_cohort', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/cohort:view', captype: 'read', contextlevel: 10, component: 'core_cohort', archetypes: { ...ALL_STAFF } },
  { name: 'lms/enrol:manage', captype: 'write', contextlevel: 50, component: 'core_enrol', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/completion:manage', captype: 'write', contextlevel: 50, component: 'core_completion', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/completion:markothers', captype: 'write', contextlevel: 50, component: 'core_completion', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // P3 — Assessment (Grades / Questions)
  { name: 'moodle/grade:manage', captype: 'write', contextlevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/grade:edit', captype: 'write', contextlevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/grade:viewall', captype: 'read', contextlevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/question:managecategory', captype: 'write', contextlevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/question:add', captype: 'write', contextlevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/question:editall', captype: 'write', contextlevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/question:useall', captype: 'read', contextlevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // P4 — Communication & Engagement
  { name: 'moodle/site:sendmessage', captype: 'write', contextlevel: 30, component: 'core_message', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/calendar:manageentries', captype: 'write', contextlevel: 50, component: 'core_calendar', archetypes: { ...ALL_STAFF } },
  { name: 'moodle/calendar:managegroupentries', captype: 'write', contextlevel: 50, component: 'core_calendar', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/calendar:manageownentries', captype: 'write', contextlevel: 30, component: 'core_calendar', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/calendar:managesubscriptions', captype: 'write', contextlevel: 10, component: 'core_calendar', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/badges:createbadge', captype: 'write', contextlevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/badges:configurecriteria', captype: 'write', contextlevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/badges:awardbadge', captype: 'write', contextlevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/badges:revokebadge', captype: 'write', contextlevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/competency:competencymanage', captype: 'write', contextlevel: 10, component: 'core_competency', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/competency:planmanage', captype: 'write', contextlevel: 30, component: 'core_competency', archetypes: { manager: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/competency:planview', captype: 'read', contextlevel: 30, component: 'core_competency', archetypes: { ...ALL_STAFF, user: CAP_ALLOW } },
  { name: 'moodle/competency:usercompetencyreview', captype: 'write', contextlevel: 10, component: 'core_competency', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/competency:coursecompetencymanage', captype: 'write', contextlevel: 50, component: 'core_competency', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/tag:edit', captype: 'write', contextlevel: 50, component: 'core_tag', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/tag:manage', captype: 'write', contextlevel: 10, component: 'core_tag', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/comment:view', captype: 'read', contextlevel: 50, component: 'core_comment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/comment:post', captype: 'write', contextlevel: 50, component: 'core_comment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/comment:delete', captype: 'write', contextlevel: 50, component: 'core_comment', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/rating:view', captype: 'read', contextlevel: 50, component: 'core_rating', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/rating:viewall', captype: 'read', contextlevel: 50, component: 'core_rating', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/rating:rate', captype: 'write', contextlevel: 50, component: 'core_rating', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/blog:create', captype: 'write', contextlevel: 30, component: 'core_blog', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/blog:view', captype: 'read', contextlevel: 10, component: 'core_blog', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/blog:manageentries', captype: 'write', contextlevel: 30, component: 'core_blog', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/notes:create', captype: 'write', contextlevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/notes:view', captype: 'read', contextlevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/notes:manage', captype: 'write', contextlevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW } },
  // Platform Services
  { name: 'lms/search:use', captype: 'read', contextlevel: 10, component: 'core_search', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/webservice:manage', captype: 'write', contextlevel: 10, component: 'core_webservice', archetypes: { manager: CAP_ALLOW } },
  { name: 'moodle/webservice:createtoken', captype: 'write', contextlevel: 10, component: 'core_webservice', archetypes: { manager: CAP_ALLOW } },
  { name: 'lms/backup:backupcourse', captype: 'write', contextlevel: 50, component: 'core_backup', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/backup:restorecourse', captype: 'write', contextlevel: 50, component: 'core_backup', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'moodle/analytics:viewinsights', captype: 'read', contextlevel: 50, component: 'core_analytics', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/analytics:manage', captype: 'write', contextlevel: 10, component: 'core_analytics', archetypes: { manager: CAP_ALLOW } },
  { name: 'lms/reportbuilder:manage', captype: 'write', contextlevel: 10, component: 'core_reportbuilder', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'lms/reportbuilder:view', captype: 'read', contextlevel: 10, component: 'core_reportbuilder', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'moodle/contentbank:viewcontent', captype: 'read', contextlevel: 50, component: 'core_contentbank', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'moodle/contentbank:upload', captype: 'write', contextlevel: 50, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'moodle/contentbank:editcontent', captype: 'write', contextlevel: 50, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'lms/payment:manageaccounts', captype: 'write', contextlevel: 10, component: 'core_payment', archetypes: { manager: CAP_ALLOW } },
  { name: 'lms/payment:pay', captype: 'write', contextlevel: 10, component: 'core_payment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/privacy:request', captype: 'write', contextlevel: 30, component: 'core_privacy', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'lms/privacy:manage', captype: 'write', contextlevel: 10, component: 'core_privacy', archetypes: { manager: CAP_ALLOW } },
];

export const CONTEXT_LEVELS = { SYSTEM: 10, USER: 30, COURSECAT: 40, COURSE: 50, MODULE: 70, BLOCK: 80 } as const;

export interface RoleDefinition { shortname: string; name: string; archetype: string; sortorder: number }
export const DEFAULT_ROLES: RoleDefinition[] = [
  { shortname: 'manager', name: 'Manager', archetype: 'manager', sortorder: 1 },
  { shortname: 'coursecreator', name: 'Course creator', archetype: 'coursecreator', sortorder: 2 },
  { shortname: 'editingteacher', name: 'Teacher', archetype: 'editingteacher', sortorder: 3 },
  { shortname: 'teacher', name: 'Non-editing teacher', archetype: 'teacher', sortorder: 4 },
  { shortname: 'student', name: 'Student', archetype: 'student', sortorder: 5 },
  { shortname: 'guest', name: 'Guest', archetype: 'guest', sortorder: 6 },
  { shortname: 'user', name: 'Authenticated user', archetype: 'user', sortorder: 7 },
];
