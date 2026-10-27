export interface CapabilityDefinition {
  name: string;
  capType: 'read' | 'write';
  contextLevel: number;
  component: string;
  /** Quyền mặc định theo từng archetype của role, được seed dưới dạng override tại context hệ thống. */
  archetypes: Partial<Record<string, number>>;
}
import { CAP_ALLOW } from './permission';

const ALL_STAFF = { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW };

/** Registry capability — các định nghĩa nằm trong code (giống db/access.php của Moodle), các dòng được đồng bộ vào `capabilities`. */
export const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  { name: 'site:config', capType: 'write', contextLevel: 10, component: 'core', archetypes: { manager: CAP_ALLOW } },
  // Multi-tenant (TENANT-0, #168): `tenant:manage` tại context HỆ THỐNG là
  // quyền của tầng platform (tạo tenant, khoá/mở, nâng cấp gói);
  // `tenant:viewall` cũng tại context hệ thống, chỉ mở cho platform admin.
  // Bên trong một tenant, tenant admin giữ vai manager TẠI CONTEXT TENANT
  // nên cùng hai capability này hiệu lực ở cây của tenant qua evaluator.
  { name: 'tenant:manage', capType: 'write', contextLevel: 20, component: 'core_tenant', archetypes: { manager: CAP_ALLOW } },
  { name: 'tenant:viewall', capType: 'read', contextLevel: 20, component: 'core_tenant', archetypes: { manager: CAP_ALLOW } },
  { name: 'site:viewuseridentity', capType: 'read', contextLevel: 10, component: 'core', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'user:create', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'user:update', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'user:delete', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'user:viewdetails', capType: 'read', contextLevel: 30, component: 'core_user', archetypes: { ...ALL_STAFF, user: CAP_ALLOW } },
  { name: 'user:loginas', capType: 'write', contextLevel: 10, component: 'core_user', archetypes: { manager: CAP_ALLOW } },
  { name: 'role:manage', capType: 'write', contextLevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'role:assign', capType: 'write', contextLevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'role:override', capType: 'write', contextLevel: 10, component: 'core_role', archetypes: { manager: CAP_ALLOW } },
  { name: 'course:view', capType: 'read', contextLevel: 50, component: 'core_course', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW, guest: CAP_ALLOW } },
  { name: 'files:view', capType: 'read', contextLevel: 50, component: 'core_files', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'files:upload', capType: 'write', contextLevel: 50, component: 'core_files', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'customfield:manage', capType: 'write', contextLevel: 10, component: 'core_customfield', archetypes: { manager: CAP_ALLOW } },
  // Khoá học & Ghi danh
  { name: 'category:manage', capType: 'write', contextLevel: 40, component: 'core_course', archetypes: { manager: CAP_ALLOW } },
  { name: 'course:create', capType: 'write', contextLevel: 40, component: 'core_course', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW } },
  { name: 'course:update', capType: 'write', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'course:delete', capType: 'write', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW } },
  { name: 'course:viewhiddencourses', capType: 'read', contextLevel: 50, component: 'core_course', archetypes: { ...ALL_STAFF } },
  { name: 'course:viewhiddenactivities', capType: 'read', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'course:manageactivities', capType: 'write', contextLevel: 50, component: 'core_course', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'course:managegroups', capType: 'write', contextLevel: 50, component: 'core_group', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  // Lớp học hạng nhất (issue #184, CLASS-0): capability tại context LỚP
  // (CLASS=45, giữa coursecat 40 và course 50). Ba quyền kiểu Azota là
  // class:manageroster (quản lý danh sách học sinh), class:assignwork
  // (giao bài/tạo khoá trong lớp), class:grade (xem + chấm bài trong lớp);
  // cấp cho đồng GV qua 3 vai hệ thống classassigner/classgrader/
  // classrostermanager gán TẠI context lớp (override đặt tại context lớp
  // lúc tạo lớp — khuôn qbankmember/qbanklead), chủ lớp giữ editingteacher
  // tại context lớp với bộ override đầy đủ đặt cùng lúc. Archetype ở đây
  // chỉ manager để quyền không tự chảy vào mọi lớp qua gán vai ở nơi khác;
  // class:create là ngoại lệ có editingteacher vì GV phải tự tạo được lớp
  // của mình (đánh giá tại context tenant, chủ lớp = người tạo).
  { name: 'class:create', capType: 'write', contextLevel: 40, component: 'core_class', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'class:view', capType: 'read', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'class:update', capType: 'write', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'class:delete', capType: 'write', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'class:manageroster', capType: 'write', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'class:assignwork', capType: 'write', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'class:grade', capType: 'write', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'class:share', capType: 'write', contextLevel: 45, component: 'core_class', archetypes: { manager: CAP_ALLOW } },
  { name: 'group:accessallgroups', capType: 'read', contextLevel: 50, component: 'core_group', archetypes: { ...ALL_STAFF } },
  { name: 'cohort:manage', capType: 'write', contextLevel: 10, component: 'core_cohort', archetypes: { manager: CAP_ALLOW } },
  { name: 'cohort:view', capType: 'read', contextLevel: 10, component: 'core_cohort', archetypes: { ...ALL_STAFF } },
  { name: 'enrol:manage', capType: 'write', contextLevel: 50, component: 'core_enrol', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'completion:manage', capType: 'write', contextLevel: 50, component: 'core_completion', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'completion:markothers', capType: 'write', contextLevel: 50, component: 'core_completion', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Đánh giá (Điểm / Câu hỏi)
  { name: 'grade:manage', capType: 'write', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'grade:edit', capType: 'write', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'grade:viewall', capType: 'read', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Công bố điểm/lời phê + kết quả (PH-0, issue #116): giáo viên giữ chốt
  // công bố theo đúng Canvas posting policy + TT 22 Đ.20 — tách khỏi
  // grade:edit để trường có thể giao quyền chấm và quyền công bố khác nhau.
  { name: 'grade:publish', capType: 'write', contextLevel: 50, component: 'core_grades', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Quản lý liên kết giám hộ PH–HS (PH-0, issue #116): trường xác lập theo
  // hồ sơ đã xác minh; service kiểm capability này từ gán vai thật ở bất kỳ
  // context nào (admin hệ thống hoặc GV của lớp/khoá của con) — archetype
  // tại context user của học sinh.
  { name: 'guardian:manage', capType: 'write', contextLevel: 30, component: 'core_guardian', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'question:managecategory', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'question:add', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'question:editall', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'question:useall', capType: 'read', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Ngân hàng câu hỏi chung (feat issue #70, QB-1): copy/share/moderate là
  // capability MỚI của lớp bank — đối chiếu research: copy theo archetype
  // manager + editingteacher (kèm teacher thường theo quyết định sản phẩm:
  // copy về bank cá nhân là thao tác an toàn, đích mới là bản độc lập);
  // share = đề xuất đóng góp (mọi giáo viên); moderate = duyệt đóng góp /
  // rút câu ở bank đích — archetype manager, giáo viên tại context khoá
  // (moderate bank khoá của mình) và vai tổ trưởng gán tại context bank.
  { name: 'question:copy', capType: 'read', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'question:share', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'question:moderate', capType: 'write', contextLevel: 50, component: 'core_question', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  // Ngân hàng ma trận: MB-1 (issue #111) mở đầu bằng bộ ba
  // copy/share/moderate; đợt đồng bộ khuôn ngân hàng (issue #228,
  // lát S3) bổ sung use/add/edit để ma trận đủ bộ
  // use/add/edit/copy/share/moderate như câu hỏi và đề, đồng thời BỎ
  // hẳn việc neo quyền xem/sửa ma trận vào quiz:viewmatrix /
  // quiz:managematrix của Chặng 3. use = xem/dùng ma trận; add = tạo
  // ma trận mới (tạo tay, nhập file, copy vào bank đích); edit = sửa
  // ma trận và các ô. Cấp tại context của BANK qua hai vai
  // qbankmember/qbanklead (QuestionBanksService.buildBank theo kind)
  // và tại context của môn cho đường chưa qua bank. Archetype của
  // use/add/edit giữ đúng archetype của cặp quiz:* cũ (mọi vai staff,
  // giáo viên là người dùng chính của ma trận) để việc đổi tên không
  // thay đổi ai đang có quyền.
  { name: 'matrix:use', capType: 'read', contextLevel: 50, component: 'core_matrix', archetypes: { ...ALL_STAFF } },
  { name: 'matrix:add', capType: 'write', contextLevel: 50, component: 'core_matrix', archetypes: { ...ALL_STAFF } },
  { name: 'matrix:edit', capType: 'write', contextLevel: 50, component: 'core_matrix', archetypes: { ...ALL_STAFF } },
  { name: 'matrix:copy', capType: 'read', contextLevel: 50, component: 'core_matrix', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'matrix:share', capType: 'write', contextLevel: 50, component: 'core_matrix', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'matrix:moderate', capType: 'write', contextLevel: 50, component: 'core_matrix', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  // Ngân hàng đề (feat issue #113, EB-1): bộ capability của lớp bank đề,
  // song song bộ question:* của QB — mọi cổng đều đánh giá TẠI context
  // của bank đề (một nguồn quyền duy nhất là bank, research G.2/E-8).
  // Đợt đồng bộ khuôn ngân hàng (issue #228, lát S3) chuẩn hoá tên về
  // cùng khuôn use/add/edit/copy/share/moderate: use = vào được bank
  // đề + xem đề ready (trước đây là exam:view); add = tạo đề mới
  // (tạo tay, sinh từ ma trận, copy vào bank đích); edit = sửa đề của
  // mình; copy = copy đề về bank khác; share = đề xuất đóng góp;
  // moderate = duyệt đóng góp + quản trị đề của người khác trong
  // bank; deploy = triển khai đề vào quiz (cộng thêm quiz:manage tại
  // context khoá đích) — deploy là capability riêng của đề như
  // managecategory là riêng của câu hỏi.
  // LƯU Ý archetype: KHÔNG cấp cho 'teacher' — nếu cấp, mọi giáo viên
  // staff đều kế thừa exam:* tại MỌI context bank qua dòng seed ở
  // context hệ thống (kể cả bank cá nhân của người khác — đúng bẫy mà
  // question:useall của QB tránh bằng cách chỉ manager/editingteacher).
  // Giáo viên staff có quyền tại bank mình thuộc về qua assignment
  // thật qbankmember/qbanklead + override exam:* tại context bank
  // (ExamsService.ensureExamGrants).
  { name: 'exam:use', capType: 'read', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'exam:add', capType: 'write', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'exam:edit', capType: 'write', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'exam:copy', capType: 'read', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'exam:share', capType: 'write', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'exam:moderate', capType: 'write', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'exam:deploy', capType: 'write', contextLevel: 50, component: 'core_exam', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  // Quiz activity (mod_quiz) — capability tại context của course module như db/access.php của Moodle.
  { name: 'quiz:view', capType: 'read', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW, student: CAP_ALLOW } },
  { name: 'quiz:attempt', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { student: CAP_ALLOW } },
  { name: 'quiz:manage', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'quiz:grade', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'quiz:gradepaper', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'quiz:viewreports', capType: 'read', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'quiz:preview', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'quiz:manageoverrides', capType: 'write', contextLevel: 70, component: 'mod_quiz', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  // Bài tập nộp tệp/ảnh (mod_assign) — capability tại context của course module.
  { name: 'assign:view', capType: 'read', contextLevel: 70, component: 'mod_assign', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW, student: CAP_ALLOW } },
  { name: 'assign:submit', capType: 'write', contextLevel: 70, component: 'mod_assign', archetypes: { student: CAP_ALLOW } },
  { name: 'assign:manage', capType: 'write', contextLevel: 70, component: 'mod_assign', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'assign:grade', capType: 'write', contextLevel: 70, component: 'mod_assign', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'assign:viewallsubmissions', capType: 'read', contextLevel: 70, component: 'mod_assign', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  // Curriculum (GDPT 2018, port từ giaokhoa — neo tại context của môn học)
  { name: 'curriculum:view', capType: 'read', contextLevel: 10, component: 'core_curriculum', archetypes: { ...ALL_STAFF } },
  { name: 'curriculum:manage', capType: 'write', contextLevel: 10, component: 'core_curriculum', archetypes: { manager: CAP_ALLOW } },
  // Giao tiếp & Tương tác
  { name: 'site:sendmessage', capType: 'write', contextLevel: 30, component: 'core_message', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  // Kiểm duyệt nội dung trao đổi (vòng đời tin nhắn theo vai, issue #33):
  // cổng cho thao tác xoá CỨNG/gỡ hàng loạt tin nhắn — staff khoá tại
  // context khoá của conversation, quản trị viên qua archetype manager.
  { name: 'moderation:manage', capType: 'write', contextLevel: 50, component: 'core_message', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'calendar:manageentries', capType: 'write', contextLevel: 50, component: 'core_calendar', archetypes: { ...ALL_STAFF } },
  { name: 'calendar:managegroupentries', capType: 'write', contextLevel: 50, component: 'core_calendar', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'calendar:manageownentries', capType: 'write', contextLevel: 30, component: 'core_calendar', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'calendar:managesubscriptions', capType: 'write', contextLevel: 10, component: 'core_calendar', archetypes: { manager: CAP_ALLOW } },
  { name: 'badges:createbadge', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'badges:configurecriteria', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'badges:awardbadge', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'badges:revokebadge', capType: 'write', contextLevel: 50, component: 'core_badges', archetypes: { manager: CAP_ALLOW } },
  { name: 'competency:competencymanage', capType: 'write', contextLevel: 10, component: 'core_competency', archetypes: { manager: CAP_ALLOW } },
  { name: 'competency:planmanage', capType: 'write', contextLevel: 30, component: 'core_competency', archetypes: { manager: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'competency:planview', capType: 'read', contextLevel: 30, component: 'core_competency', archetypes: { ...ALL_STAFF, user: CAP_ALLOW } },
  { name: 'competency:usercompetencyreview', capType: 'write', contextLevel: 10, component: 'core_competency', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'competency:coursecompetencymanage', capType: 'write', contextLevel: 50, component: 'core_competency', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'tag:edit', capType: 'write', contextLevel: 50, component: 'core_tag', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'tag:manage', capType: 'write', contextLevel: 10, component: 'core_tag', archetypes: { manager: CAP_ALLOW } },
  { name: 'comment:view', capType: 'read', contextLevel: 50, component: 'core_comment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'comment:post', capType: 'write', contextLevel: 50, component: 'core_comment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'comment:delete', capType: 'write', contextLevel: 50, component: 'core_comment', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'rating:view', capType: 'read', contextLevel: 50, component: 'core_rating', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'rating:viewall', capType: 'read', contextLevel: 50, component: 'core_rating', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'rating:rate', capType: 'write', contextLevel: 50, component: 'core_rating', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'notes:create', capType: 'write', contextLevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'notes:view', capType: 'read', contextLevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'notes:manage', capType: 'write', contextLevel: 50, component: 'core_notes', archetypes: { manager: CAP_ALLOW } },
  // Dịch vụ nền tảng
  { name: 'search:use', capType: 'read', contextLevel: 10, component: 'core_search', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  // Vá H2+H5 (sổ rà soát gác quyền #134): ghi/xoá/reindex chỉ mục tìm kiếm là
  // thao tác bảo trì toàn hệ (index-raw cho phép chèn tài liệu tuỳ ý) — chỉ
  // quản trị hệ thống tại system context mới được gọi các route ghi của search.
  { name: 'search:manage', capType: 'write', contextLevel: 10, component: 'core_search', archetypes: { manager: CAP_ALLOW } },
  { name: 'webservice:manage', capType: 'write', contextLevel: 10, component: 'core_webservice', archetypes: { manager: CAP_ALLOW } },
  { name: 'webservice:createtoken', capType: 'write', contextLevel: 10, component: 'core_webservice', archetypes: { manager: CAP_ALLOW } },
  { name: 'backup:backupcourse', capType: 'write', contextLevel: 50, component: 'core_backup', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'backup:restorecourse', capType: 'write', contextLevel: 50, component: 'core_backup', archetypes: { manager: CAP_ALLOW, coursecreator: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'analytics:viewinsights', capType: 'read', contextLevel: 50, component: 'core_analytics', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'analytics:manage', capType: 'write', contextLevel: 10, component: 'core_analytics', archetypes: { manager: CAP_ALLOW } },
  { name: 'log:view', capType: 'read', contextLevel: 50, component: 'report_log', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'reportbuilder:manage', capType: 'write', contextLevel: 10, component: 'core_reportbuilder', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'reportbuilder:view', capType: 'read', contextLevel: 10, component: 'core_reportbuilder', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'contentbank:viewcontent', capType: 'read', contextLevel: 50, component: 'core_contentbank', archetypes: { ...ALL_STAFF, student: CAP_ALLOW } },
  { name: 'contentbank:upload', capType: 'write', contextLevel: 50, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW, teacher: CAP_ALLOW } },
  { name: 'contentbank:editcontent', capType: 'write', contextLevel: 50, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'contentbank:reviewcontent', capType: 'write', contextLevel: 10, component: 'core_contentbank', archetypes: { manager: CAP_ALLOW, editingteacher: CAP_ALLOW } },
  { name: 'payment:manageaccounts', capType: 'write', contextLevel: 10, component: 'core_payment', archetypes: { manager: CAP_ALLOW } },
  { name: 'payment:pay', capType: 'write', contextLevel: 10, component: 'core_payment', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'privacy:request', capType: 'write', contextLevel: 30, component: 'core_privacy', archetypes: { ...ALL_STAFF, student: CAP_ALLOW, user: CAP_ALLOW } },
  { name: 'privacy:manage', capType: 'write', contextLevel: 10, component: 'core_privacy', archetypes: { manager: CAP_ALLOW } },
];

export const CONTEXT_LEVELS = { SYSTEM: 10, TENANT: 20, USER: 30, COURSECAT: 40, CLASS: 45, COURSE: 50, MODULE: 70, BLOCK: 80 } as const;

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
