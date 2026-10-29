/**
 * Khai relations Drizzle cho TOÀN BỘ schema dùng chung ở `@lms/db` — dùng bởi
 * `drizzle({ relations })` khi worker khởi tạo kết nối cơ sở dữ liệu.
 *
 * Luồng dữ liệu: WorkerModule nạp `relations` này vào client Drizzle cùng
 * pool kết nối; các processor/scheduler dùng tầng relational query
 * (`db.query.*`) để nạp dữ liệu lồng nhau (`with:`) khi xử lý job.
 * Relations là metadata thuần tuý: KHÔNG đổi schema (bảng, cột, khoá ngoại
 * đều giữ nguyên, không có migration) và KHÔNG đổi hành vi job hiện có.
 *
 * Quy ước suy từ khoá ngoại thật của `@lms/db`:
 * - Mỗi khoá ngoại có đúng hai khai báo: một quan hệ `one` ở bảng giữ khoá
 *   ngoại, và một quan hệ ngược ở bảng đích — `many`, hoặc `one` khi cột khoá
 *   ngoại là unique (quan hệ một–một).
 * - `optional: false` chỉ đặt khi cột khoá ngoại NOT NULL (bản ghi liên quan
 *   chắc chắn tồn tại); cột nullable để mặc định (kết quả có thể `null`).
 * - Cặp bảng có nhiều khoá ngoại song song (hoặc bảng tự tham chiếu) thì đặt
 *   `alias` bằng chính tên quan hệ để phân biệt các quan hệ đó.
 * - Cột trỏ mềm (không có ràng buộc khoá ngoại trong schema) KHÔNG khai ở
 *   đây — danh sách quan hệ bám đúng khoá ngoại thật.
 *
 * Cấu trúc file bám theo từng file schema của `packages/db/src`; thân cấu
 * hình giống hệt phía api (chỉ khác điểm nhập schema) để hai app nhất quán
 * về tên và chiều quan hệ.
 */
import { defineRelations } from 'drizzle-orm';

import * as schema from '@lms/db';

export const relations = defineRelations(schema, (r) => ({
    // ── access.schema.ts — Phân quyền theo ngữ cảnh ──
    context: {
      roleAssignments: r.many.roleAssignments({ from: r.context.id, to: r.roleAssignments.contextId }),
      roleCapabilities: r.many.roleCapabilities({ from: r.context.id, to: r.roleCapabilities.contextId }),
    },
    role: {
      courseCompletionCriteria: r.many.courseCompletionCriteria({ from: r.role.id, to: r.courseCompletionCriteria.roleId }),
      roleAssignments: r.many.roleAssignments({ from: r.role.id, to: r.roleAssignments.roleId }),
      roleCapabilities: r.many.roleCapabilities({ from: r.role.id, to: r.roleCapabilities.roleId }),
    },
    roleAssignments: {
      role: r.one.role({ from: r.roleAssignments.roleId, to: r.role.id, optional: false }),
      context: r.one.context({ from: r.roleAssignments.contextId, to: r.context.id, optional: false }),
    },
    roleCapabilities: {
      context: r.one.context({ from: r.roleCapabilities.contextId, to: r.context.id, optional: false }),
      role: r.one.role({ from: r.roleCapabilities.roleId, to: r.role.id, optional: false }),
    },
    // ── users.schema.ts — Người dùng ──
    users: {
      totp: r.one.userTotp({ from: r.users.id, to: r.userTotp.userId }),
      authAccounts: r.many.authAccount({ from: r.users.id, to: r.authAccount.userId }),
      authSessions: r.many.authSession({ from: r.users.id, to: r.authSession.userId }),
      authTwoFactors: r.many.authTwoFactor({ from: r.users.id, to: r.authTwoFactor.userId }),
      classJoinRequestsAsUser: r.many.classJoinRequests({ from: r.users.id, to: r.classJoinRequests.userId, alias: 'classJoinRequestsAsUser' }),
      classJoinRequestsAsDecidedBy: r.many.classJoinRequests({ from: r.users.id, to: r.classJoinRequests.decidedBy, alias: 'classJoinRequestsAsDecidedBy' }),
      classes: r.many.classes({ from: r.users.id, to: r.classes.ownerId }),
      guardianDigestsAsGuardianUser: r.many.guardianDigests({ from: r.users.id, to: r.guardianDigests.guardianUserId, alias: 'guardianDigestsAsGuardianUser' }),
      guardianDigestsAsStudentUser: r.many.guardianDigests({ from: r.users.id, to: r.guardianDigests.studentUserId, alias: 'guardianDigestsAsStudentUser' }),
      guardianLinksAsGuardianUser: r.many.guardianLinks({ from: r.users.id, to: r.guardianLinks.guardianUserId, alias: 'guardianLinksAsGuardianUser' }),
      guardianLinksAsStudentUser: r.many.guardianLinks({ from: r.users.id, to: r.guardianLinks.studentUserId, alias: 'guardianLinksAsStudentUser' }),
      guardianViewStateAsGuardianUser: r.many.guardianViewState({ from: r.users.id, to: r.guardianViewState.guardianUserId, alias: 'guardianViewStateAsGuardianUser' }),
      guardianViewStateAsStudentUser: r.many.guardianViewState({ from: r.users.id, to: r.guardianViewState.studentUserId, alias: 'guardianViewStateAsStudentUser' }),
      loginAttempts: r.many.loginAttempts({ from: r.users.id, to: r.loginAttempts.userId }),
      oauthAccessTokens: r.many.oauthAccessToken({ from: r.users.id, to: r.oauthAccessToken.userId }),
      oauthClients: r.many.oauthClient({ from: r.users.id, to: r.oauthClient.userId }),
      oauthConsents: r.many.oauthConsent({ from: r.users.id, to: r.oauthConsent.userId }),
      oauthRefreshTokens: r.many.oauthRefreshToken({ from: r.users.id, to: r.oauthRefreshToken.userId }),
      paymentCoupons: r.many.paymentCoupons({ from: r.users.id, to: r.paymentCoupons.createdBy }),
      paymentRefundsAsCreatedBy: r.many.paymentRefunds({ from: r.users.id, to: r.paymentRefunds.createdBy, alias: 'paymentRefundsAsCreatedBy' }),
      paymentRefundsAsApprovedBy: r.many.paymentRefunds({ from: r.users.id, to: r.paymentRefunds.approvedBy, alias: 'paymentRefundsAsApprovedBy' }),
      paymentRefundsAsRejectedBy: r.many.paymentRefunds({ from: r.users.id, to: r.paymentRefunds.rejectedBy, alias: 'paymentRefundsAsRejectedBy' }),
      paymentRefundsAsSettledBy: r.many.paymentRefunds({ from: r.users.id, to: r.paymentRefunds.settledBy, alias: 'paymentRefundsAsSettledBy' }),
      reviewedPayments: r.many.payments({ from: r.users.id, to: r.payments.reviewHandledBy }),
      refreshTokenFamilies: r.many.refreshTokenFamily({ from: r.users.id, to: r.refreshTokenFamily.userId }),
      tenantMemberships: r.many.tenantMemberships({ from: r.users.id, to: r.tenantMemberships.userId }),
      userOauthLinks: r.many.userOauthLinks({ from: r.users.id, to: r.userOauthLinks.userId }),
      userPreferences: r.many.userPreferences({ from: r.users.id, to: r.userPreferences.userId }),
    },
    userPreferences: {
      user: r.one.users({ from: r.userPreferences.userId, to: r.users.id, optional: false }),
    },
    // ── tenants.schema.ts — Tenant (trung tâm giáo dục) ──
    tenants: {
      classJoinRequests: r.many.classJoinRequests({ from: r.tenants.id, to: r.classJoinRequests.tenantId }),
      classes: r.many.classes({ from: r.tenants.id, to: r.classes.tenantId }),
      cohorts: r.many.cohort({ from: r.tenants.id, to: r.cohort.tenantId }),
      courses: r.many.course({ from: r.tenants.id, to: r.course.tenantId }),
      courseCategories: r.many.courseCategories({ from: r.tenants.id, to: r.courseCategories.tenantId }),
      examMatrices: r.many.examMatrices({ from: r.tenants.id, to: r.examMatrices.tenantId }),
      exams: r.many.exams({ from: r.tenants.id, to: r.exams.tenantId }),
      guardianDigests: r.many.guardianDigests({ from: r.tenants.id, to: r.guardianDigests.tenantId }),
      guardianLinks: r.many.guardianLinks({ from: r.tenants.id, to: r.guardianLinks.tenantId }),
      learningOutcomes: r.many.learningOutcomes({ from: r.tenants.id, to: r.learningOutcomes.tenantId }),
      messageConversations: r.many.messageConversations({ from: r.tenants.id, to: r.messageConversations.tenantId }),
      notificationDispatchLogs: r.many.notificationDispatchLog({ from: r.tenants.id, to: r.notificationDispatchLog.tenantId }),
      notifications: r.many.notifications({ from: r.tenants.id, to: r.notifications.tenantId }),
      paymentAccounts: r.many.paymentAccounts({ from: r.tenants.id, to: r.paymentAccounts.tenantId }),
      paymentProviderEvents: r.many.paymentProviderEvents({ from: r.tenants.id, to: r.paymentProviderEvents.tenantId }),
      payments: r.many.payments({ from: r.tenants.id, to: r.payments.tenantId }),
      planEntitlements: r.many.planEntitlements({ from: r.tenants.id, to: r.planEntitlements.tenantId }),
      questionBanks: r.many.questionBanks({ from: r.tenants.id, to: r.questionBanks.tenantId }),
      tenantConfigs: r.many.tenantConfig({ from: r.tenants.id, to: r.tenantConfig.tenantId }),
      tenantMemberships: r.many.tenantMemberships({ from: r.tenants.id, to: r.tenantMemberships.tenantId }),
    },
    tenantMemberships: {
      tenant: r.one.tenants({ from: r.tenantMemberships.tenantId, to: r.tenants.id, optional: false }),
      user: r.one.users({ from: r.tenantMemberships.userId, to: r.users.id, optional: false }),
    },
    tenantConfig: {
      tenant: r.one.tenants({ from: r.tenantConfig.tenantId, to: r.tenants.id, optional: false }),
    },
    // ── auth.schema.ts — Xác thực & OAuth ──
    refreshTokenFamily: {
      user: r.one.users({ from: r.refreshTokenFamily.userId, to: r.users.id, optional: false }),
    },
    userTotp: {
      user: r.one.users({ from: r.userTotp.userId, to: r.users.id, optional: false }),
    },
    userOauthLinks: {
      user: r.one.users({ from: r.userOauthLinks.userId, to: r.users.id, optional: false }),
    },
    authSession: {
      user: r.one.users({ from: r.authSession.userId, to: r.users.id, optional: false }),
      oauthAccessTokens: r.many.oauthAccessToken({ from: r.authSession.id, to: r.oauthAccessToken.sessionId }),
      oauthRefreshTokens: r.many.oauthRefreshToken({ from: r.authSession.id, to: r.oauthRefreshToken.sessionId }),
    },
    authAccount: {
      user: r.one.users({ from: r.authAccount.userId, to: r.users.id, optional: false }),
    },
    authTwoFactor: {
      user: r.one.users({ from: r.authTwoFactor.userId, to: r.users.id, optional: false }),
    },
    oauthClient: {
      user: r.one.users({ from: r.oauthClient.userId, to: r.users.id }),
      oauthAccessTokens: r.many.oauthAccessToken({ from: r.oauthClient.clientId, to: r.oauthAccessToken.clientId }),
      oauthClientResources: r.many.oauthClientResource({ from: r.oauthClient.clientId, to: r.oauthClientResource.clientId }),
      oauthConsents: r.many.oauthConsent({ from: r.oauthClient.clientId, to: r.oauthConsent.clientId }),
      oauthRefreshTokens: r.many.oauthRefreshToken({ from: r.oauthClient.clientId, to: r.oauthRefreshToken.clientId }),
    },
    oauthResource: {
      oauthClientResources: r.many.oauthClientResource({ from: r.oauthResource.identifier, to: r.oauthClientResource.resourceId }),
    },
    oauthClientResource: {
      client: r.one.oauthClient({ from: r.oauthClientResource.clientId, to: r.oauthClient.clientId, optional: false }),
      resource: r.one.oauthResource({ from: r.oauthClientResource.resourceId, to: r.oauthResource.identifier, optional: false }),
    },
    oauthRefreshToken: {
      client: r.one.oauthClient({ from: r.oauthRefreshToken.clientId, to: r.oauthClient.clientId, optional: false }),
      session: r.one.authSession({ from: r.oauthRefreshToken.sessionId, to: r.authSession.id }),
      user: r.one.users({ from: r.oauthRefreshToken.userId, to: r.users.id, optional: false }),
      oauthAccessTokens: r.many.oauthAccessToken({ from: r.oauthRefreshToken.id, to: r.oauthAccessToken.refreshId }),
    },
    oauthAccessToken: {
      client: r.one.oauthClient({ from: r.oauthAccessToken.clientId, to: r.oauthClient.clientId, optional: false }),
      session: r.one.authSession({ from: r.oauthAccessToken.sessionId, to: r.authSession.id }),
      user: r.one.users({ from: r.oauthAccessToken.userId, to: r.users.id }),
      refresh: r.one.oauthRefreshToken({ from: r.oauthAccessToken.refreshId, to: r.oauthRefreshToken.id }),
    },
    oauthConsent: {
      client: r.one.oauthClient({ from: r.oauthConsent.clientId, to: r.oauthClient.clientId, optional: false }),
      user: r.one.users({ from: r.oauthConsent.userId, to: r.users.id }),
    },
    loginAttempts: {
      user: r.one.users({ from: r.loginAttempts.userId, to: r.users.id }),
    },
    // ── custom-fields.schema.ts — Trường tuỳ biến ──
    customFieldCategory: {
      customFieldFields: r.many.customFieldField({ from: r.customFieldCategory.id, to: r.customFieldField.categoryId }),
    },
    customFieldField: {
      category: r.one.customFieldCategory({ from: r.customFieldField.categoryId, to: r.customFieldCategory.id, optional: false }),
      customFieldData: r.many.customFieldData({ from: r.customFieldField.id, to: r.customFieldData.fieldId }),
    },
    customFieldData: {
      field: r.one.customFieldField({ from: r.customFieldData.fieldId, to: r.customFieldField.id, optional: false }),
    },
    // ── files.schema.ts — Tệp ──
    files: {
      assignAnnotations: r.many.assignAnnotations({ from: r.files.id, to: r.assignAnnotations.fileId }),
      assignSubmissionFiles: r.many.assignSubmissionFiles({ from: r.files.id, to: r.assignSubmissionFiles.fileId }),
      resources: r.many.resources({ from: r.files.id, to: r.resources.fileId }),
    },
    // ── courses.schema.ts — Khoá học ──
    courseCategories: {
      tenant: r.one.tenants({ from: r.courseCategories.tenantId, to: r.tenants.id, optional: false }),
      courses: r.many.course({ from: r.courseCategories.id, to: r.course.category }),
    },
    course: {
      tenant: r.one.tenants({ from: r.course.tenantId, to: r.tenants.id, optional: false }),
      categoryRef: r.one.courseCategories({ from: r.course.category, to: r.courseCategories.id, optional: false }),
      subject: r.one.subjects({ from: r.course.subjectId, to: r.subjects.id }),
      class: r.one.classes({ from: r.course.classId, to: r.classes.id }),
      completionSettings: r.one.courseCompletionSettings({ from: r.course.id, to: r.courseCompletionSettings.course }),
      assignments: r.many.assignments({ from: r.course.id, to: r.assignments.course }),
      courseCompletionCriteriaAsCourse: r.many.courseCompletionCriteria({ from: r.course.id, to: r.courseCompletionCriteria.course, alias: 'courseCompletionCriteriaAsCourse' }),
      courseCompletionCriteriaAsCourseInstance: r.many.courseCompletionCriteria({ from: r.course.id, to: r.courseCompletionCriteria.courseInstance, alias: 'courseCompletionCriteriaAsCourseInstance' }),
      courseCompletions: r.many.courseCompletions({ from: r.course.id, to: r.courseCompletions.course }),
      courseFormatOptions: r.many.courseFormatOptions({ from: r.course.id, to: r.courseFormatOptions.courseId }),
      courseGroups: r.many.courseGroups({ from: r.course.id, to: r.courseGroups.courseId }),
      courseLastAccess: r.many.courseLastAccess({ from: r.course.id, to: r.courseLastAccess.courseId }),
      courseModuleProgress: r.many.courseModuleProgress({ from: r.course.id, to: r.courseModuleProgress.courseId }),
      courseModules: r.many.courseModules({ from: r.course.id, to: r.courseModules.course }),
      courseSections: r.many.courseSections({ from: r.course.id, to: r.courseSections.course }),
      enrols: r.many.enrol({ from: r.course.id, to: r.enrol.courseId }),
      examPins: r.many.examPins({ from: r.course.id, to: r.examPins.courseId }),
      gradeItems: r.many.gradeItems({ from: r.course.id, to: r.gradeItems.courseId }),
      gradePublications: r.many.gradePublications({ from: r.course.id, to: r.gradePublications.courseId }),
      groupings: r.many.groupings({ from: r.course.id, to: r.groupings.courseId }),
      pages: r.many.pages({ from: r.course.id, to: r.pages.course }),
      resources: r.many.resources({ from: r.course.id, to: r.resources.course }),
      userCourseCardPrefs: r.many.userCourseCardPrefs({ from: r.course.id, to: r.userCourseCardPrefs.courseId }),
    },
    courseSections: {
      courseRef: r.one.course({ from: r.courseSections.course, to: r.course.id, optional: false }),
      courseModules: r.many.courseModules({ from: r.courseSections.id, to: r.courseModules.section }),
      courseSectionAnchors: r.many.courseSectionAnchors({ from: r.courseSections.id, to: r.courseSectionAnchors.sectionId }),
      courseSectionBookAnchors: r.many.courseSectionBookAnchors({ from: r.courseSections.id, to: r.courseSectionBookAnchors.sectionId }),
    },
    courseModules: {
      courseRef: r.one.course({ from: r.courseModules.course, to: r.course.id, optional: false }),
      sectionRef: r.one.courseSections({ from: r.courseModules.section, to: r.courseSections.id, optional: false }),
      courseLastAccess: r.many.courseLastAccess({ from: r.courseModules.id, to: r.courseLastAccess.cmId }),
      courseModuleProgress: r.many.courseModuleProgress({ from: r.courseModules.id, to: r.courseModuleProgress.cmId }),
      courseModulesCompletions: r.many.courseModulesCompletion({ from: r.courseModules.id, to: r.courseModulesCompletion.courseModuleId }),
    },
    courseSectionAnchors: {
      section: r.one.courseSections({ from: r.courseSectionAnchors.sectionId, to: r.courseSections.id, optional: false }),
      node: r.one.curriculumNodes({ from: r.courseSectionAnchors.nodeId, to: r.curriculumNodes.id }),
      curriculum: r.one.curricula({ from: r.courseSectionAnchors.curriculumId, to: r.curricula.id }),
      courseSectionAnchorOutcomes: r.many.courseSectionAnchorOutcomes({ from: r.courseSectionAnchors.id, to: r.courseSectionAnchorOutcomes.anchorId }),
    },
    courseSectionAnchorOutcomes: {
      anchor: r.one.courseSectionAnchors({ from: r.courseSectionAnchorOutcomes.anchorId, to: r.courseSectionAnchors.id, optional: false }),
      outcome: r.one.learningOutcomes({ from: r.courseSectionAnchorOutcomes.outcomeId, to: r.learningOutcomes.id }),
    },
    courseSectionBookAnchors: {
      section: r.one.courseSections({ from: r.courseSectionBookAnchors.sectionId, to: r.courseSections.id, optional: false }),
      bookNode: r.one.bookNodes({ from: r.courseSectionBookAnchors.bookNodeId, to: r.bookNodes.id }),
      book: r.one.books({ from: r.courseSectionBookAnchors.bookId, to: r.books.id }),
      courseSectionBookItems: r.many.courseSectionBookItems({ from: r.courseSectionBookAnchors.id, to: r.courseSectionBookItems.anchorId }),
    },
    courseSectionBookItems: {
      anchor: r.one.courseSectionBookAnchors({ from: r.courseSectionBookItems.anchorId, to: r.courseSectionBookAnchors.id, optional: false }),
      bookNode: r.one.bookNodes({ from: r.courseSectionBookItems.bookNodeId, to: r.bookNodes.id }),
      courseSectionBookItemOutcomes: r.many.courseSectionBookItemOutcomes({ from: r.courseSectionBookItems.id, to: r.courseSectionBookItemOutcomes.itemId }),
    },
    courseSectionBookItemOutcomes: {
      item: r.one.courseSectionBookItems({ from: r.courseSectionBookItemOutcomes.itemId, to: r.courseSectionBookItems.id, optional: false }),
      outcome: r.one.learningOutcomes({ from: r.courseSectionBookItemOutcomes.outcomeId, to: r.learningOutcomes.id }),
    },
    courseFormatOptions: {
      course: r.one.course({ from: r.courseFormatOptions.courseId, to: r.course.id, optional: false }),
    },
    // ── groups.schema.ts — Nhóm & cohort ──
    courseGroups: {
      course: r.one.course({ from: r.courseGroups.courseId, to: r.course.id, optional: false }),
      examPinOverrides: r.many.examPinOverrides({ from: r.courseGroups.id, to: r.examPinOverrides.groupId }),
      examPins: r.many.examPins({ from: r.courseGroups.id, to: r.examPins.targetGroupId }),
      groupingsGroups: r.many.groupingsGroups({ from: r.courseGroups.id, to: r.groupingsGroups.groupId }),
      groupsMembers: r.many.groupsMembers({ from: r.courseGroups.id, to: r.groupsMembers.groupId }),
    },
    groupsMembers: {
      group: r.one.courseGroups({ from: r.groupsMembers.groupId, to: r.courseGroups.id, optional: false }),
    },
    groupings: {
      course: r.one.course({ from: r.groupings.courseId, to: r.course.id, optional: false }),
      groupingsGroups: r.many.groupingsGroups({ from: r.groupings.id, to: r.groupingsGroups.groupingId }),
    },
    groupingsGroups: {
      grouping: r.one.groupings({ from: r.groupingsGroups.groupingId, to: r.groupings.id, optional: false }),
      group: r.one.courseGroups({ from: r.groupingsGroups.groupId, to: r.courseGroups.id, optional: false }),
    },
    cohort: {
      linkedClass: r.one.classes({ from: r.cohort.id, to: r.classes.cohortId }),
      tenant: r.one.tenants({ from: r.cohort.tenantId, to: r.tenants.id, optional: false }),
      cohortMembers: r.many.cohortMembers({ from: r.cohort.id, to: r.cohortMembers.cohortId }),
    },
    cohortMembers: {
      cohort: r.one.cohort({ from: r.cohortMembers.cohortId, to: r.cohort.id, optional: false }),
    },
    // ── classes.schema.ts — Lớp học ──
    classJoinRequests: {
      tenant: r.one.tenants({ from: r.classJoinRequests.tenantId, to: r.tenants.id, optional: false }),
      class: r.one.classes({ from: r.classJoinRequests.classId, to: r.classes.id, optional: false }),
      user: r.one.users({ from: r.classJoinRequests.userId, to: r.users.id, optional: false, alias: 'user' }),
      decidedByRef: r.one.users({ from: r.classJoinRequests.decidedBy, to: r.users.id, alias: 'decidedByRef' }),
    },
    classes: {
      tenant: r.one.tenants({ from: r.classes.tenantId, to: r.tenants.id, optional: false }),
      owner: r.one.users({ from: r.classes.ownerId, to: r.users.id, optional: false }),
      cohort: r.one.cohort({ from: r.classes.cohortId, to: r.cohort.id, optional: false }),
      feePaymentAccount: r.one.paymentAccounts({ from: r.classes.feePaymentAccountId, to: r.paymentAccounts.id }),
      classJoinRequests: r.many.classJoinRequests({ from: r.classes.id, to: r.classJoinRequests.classId }),
      courses: r.many.course({ from: r.classes.id, to: r.course.classId }),
    },
    // ── enrol.schema.ts — Ghi danh ──
    enrol: {
      course: r.one.course({ from: r.enrol.courseId, to: r.course.id, optional: false }),
      userEnrolments: r.many.userEnrolments({ from: r.enrol.id, to: r.userEnrolments.enrolId }),
    },
    userEnrolments: {
      enrol: r.one.enrol({ from: r.userEnrolments.enrolId, to: r.enrol.id, optional: false }),
    },
    // ── completion.schema.ts — Hoàn thành khoá học ──
    courseModulesCompletion: {
      courseModule: r.one.courseModules({ from: r.courseModulesCompletion.courseModuleId, to: r.courseModules.id, optional: false }),
    },
    courseCompletionCriteria: {
      courseRef: r.one.course({ from: r.courseCompletionCriteria.course, to: r.course.id, optional: false, alias: 'courseRef' }),
      courseInstanceRef: r.one.course({ from: r.courseCompletionCriteria.courseInstance, to: r.course.id, alias: 'courseInstanceRef' }),
      role: r.one.role({ from: r.courseCompletionCriteria.roleId, to: r.role.id }),
      courseCompletionCritCompls: r.many.courseCompletionCritCompl({ from: r.courseCompletionCriteria.id, to: r.courseCompletionCritCompl.criteriaId }),
    },
    courseCompletionCritCompl: {
      criteria: r.one.courseCompletionCriteria({ from: r.courseCompletionCritCompl.criteriaId, to: r.courseCompletionCriteria.id, optional: false }),
    },
    courseCompletionSettings: {
      courseRef: r.one.course({ from: r.courseCompletionSettings.course, to: r.course.id, optional: false }),
    },
    courseCompletions: {
      courseRef: r.one.course({ from: r.courseCompletions.course, to: r.course.id, optional: false }),
    },
    // ── grades.schema.ts — Điểm số ──
    gradeItems: {
      course: r.one.course({ from: r.gradeItems.courseId, to: r.course.id, optional: false }),
      gradeGrades: r.many.gradeGrades({ from: r.gradeItems.id, to: r.gradeGrades.itemId }),
      gradePublications: r.many.gradePublications({ from: r.gradeItems.id, to: r.gradePublications.itemId }),
    },
    gradeGrades: {
      item: r.one.gradeItems({ from: r.gradeGrades.itemId, to: r.gradeItems.id, optional: false }),
    },
    gradePublications: {
      course: r.one.course({ from: r.gradePublications.courseId, to: r.course.id, optional: false }),
      item: r.one.gradeItems({ from: r.gradePublications.itemId, to: r.gradeItems.id }),
    },
    // ── guardians.schema.ts — Phụ huynh ──
    guardianLinks: {
      tenant: r.one.tenants({ from: r.guardianLinks.tenantId, to: r.tenants.id, optional: false }),
      guardianUser: r.one.users({ from: r.guardianLinks.guardianUserId, to: r.users.id, optional: false, alias: 'guardianUser' }),
      studentUser: r.one.users({ from: r.guardianLinks.studentUserId, to: r.users.id, optional: false, alias: 'studentUser' }),
    },
    guardianViewState: {
      guardianUser: r.one.users({ from: r.guardianViewState.guardianUserId, to: r.users.id, optional: false, alias: 'guardianUser' }),
      studentUser: r.one.users({ from: r.guardianViewState.studentUserId, to: r.users.id, optional: false, alias: 'studentUser' }),
    },
    guardianDigests: {
      guardianUser: r.one.users({ from: r.guardianDigests.guardianUserId, to: r.users.id, optional: false, alias: 'guardianUser' }),
      studentUser: r.one.users({ from: r.guardianDigests.studentUserId, to: r.users.id, optional: false, alias: 'studentUser' }),
      tenant: r.one.tenants({ from: r.guardianDigests.tenantId, to: r.tenants.id }),
    },
    // ── dashboard.schema.ts — Bảng điều khiển ──
    userCourseCardPrefs: {
      course: r.one.course({ from: r.userCourseCardPrefs.courseId, to: r.course.id, optional: false }),
    },
    // ── questions.schema.ts — Câu hỏi & ngân hàng câu hỏi ──
    questionBanks: {
      tenant: r.one.tenants({ from: r.questionBanks.tenantId, to: r.tenants.id }),
      examContributions: r.many.examContributions({ from: r.questionBanks.id, to: r.examContributions.targetBankId }),
      examDossiers: r.many.examDossiers({ from: r.questionBanks.id, to: r.examDossiers.targetBankId }),
      examMatrices: r.many.examMatrices({ from: r.questionBanks.id, to: r.examMatrices.bankId }),
      examMatrixContributions: r.many.examMatrixContributions({ from: r.questionBanks.id, to: r.examMatrixContributions.targetBankId }),
      exams: r.many.exams({ from: r.questionBanks.id, to: r.exams.bankId }),
      questionBankContributions: r.many.questionBankContributions({ from: r.questionBanks.id, to: r.questionBankContributions.targetBankId }),
      questionCategories: r.many.questionCategories({ from: r.questionBanks.id, to: r.questionCategories.bankId }),
    },
    questionCategories: {
      bank: r.one.questionBanks({ from: r.questionCategories.bankId, to: r.questionBanks.id }),
      contentBankContents: r.many.contentBankContent({ from: r.questionCategories.id, to: r.contentBankContent.questionCategoryId }),
      questions: r.many.question({ from: r.questionCategories.id, to: r.question.category }),
      questionBankEntries: r.many.questionBankEntries({ from: r.questionCategories.id, to: r.questionBankEntries.questionCategoryId }),
      stimuli: r.many.stimuli({ from: r.questionCategories.id, to: r.stimuli.categoryId }),
    },
    stimuli: {
      category: r.one.questionCategories({ from: r.stimuli.categoryId, to: r.questionCategories.id, optional: false }),
      questionVersions: r.many.questionVersions({ from: r.stimuli.id, to: r.questionVersions.stimulusId }),
    },
    question: {
      categoryRef: r.one.questionCategories({ from: r.question.category, to: r.questionCategories.id, optional: false }),
      examAttemptRegrades: r.many.examAttemptRegrades({ from: r.question.id, to: r.examAttemptRegrades.questionId }),
      examSlots: r.many.examSlots({ from: r.question.id, to: r.examSlots.questionId }),
      questionAttempts: r.many.questionAttempts({ from: r.question.id, to: r.questionAttempts.questionId }),
      questionBankContributions: r.many.questionBankContributions({ from: r.question.id, to: r.questionBankContributions.questionId }),
      questionBankEntries: r.many.questionBankEntries({ from: r.question.id, to: r.questionBankEntries.questionId }),
      questionLearningOutcomes: r.many.questionLearningOutcomes({ from: r.question.id, to: r.questionLearningOutcomes.questionId }),
      questionSubjects: r.many.questionSubjects({ from: r.question.id, to: r.questionSubjects.questionId }),
      questionVersions: r.many.questionVersions({ from: r.question.id, to: r.questionVersions.questionId }),
    },
    questionBankEntries: {
      questionCategory: r.one.questionCategories({ from: r.questionBankEntries.questionCategoryId, to: r.questionCategories.id, optional: false }),
      question: r.one.question({ from: r.questionBankEntries.questionId, to: r.question.id, optional: false }),
      questionVersions: r.many.questionVersions({ from: r.questionBankEntries.id, to: r.questionVersions.questionBankEntryId }),
    },
    questionBankContributions: {
      question: r.one.question({ from: r.questionBankContributions.questionId, to: r.question.id, optional: false }),
      targetBank: r.one.questionBanks({ from: r.questionBankContributions.targetBankId, to: r.questionBanks.id, optional: false }),
    },
    questionVersions: {
      questionBankEntry: r.one.questionBankEntries({ from: r.questionVersions.questionBankEntryId, to: r.questionBankEntries.id, optional: false }),
      question: r.one.question({ from: r.questionVersions.questionId, to: r.question.id, optional: false }),
      stimulus: r.one.stimuli({ from: r.questionVersions.stimulusId, to: r.stimuli.id }),
      examAttemptRegradesAsFromVersion: r.many.examAttemptRegrades({ from: r.questionVersions.id, to: r.examAttemptRegrades.fromVersionId, alias: 'examAttemptRegradesAsFromVersion' }),
      examAttemptRegradesAsToVersion: r.many.examAttemptRegrades({ from: r.questionVersions.id, to: r.examAttemptRegrades.toVersionId, alias: 'examAttemptRegradesAsToVersion' }),
      qtypeEssayOptions: r.many.qtypeEssayOptions({ from: r.questionVersions.id, to: r.qtypeEssayOptions.questionVersionId }),
      qtypeMultichoiceOptions: r.many.qtypeMultichoiceOptions({ from: r.questionVersions.id, to: r.qtypeMultichoiceOptions.questionVersionId }),
      qtypeShortanswerOptions: r.many.qtypeShortanswerOptions({ from: r.questionVersions.id, to: r.qtypeShortanswerOptions.questionVersionId }),
      questionAnswerKeys: r.many.questionAnswerKeys({ from: r.questionVersions.id, to: r.questionAnswerKeys.questionVersionId }),
      questionAnswers: r.many.questionAnswers({ from: r.questionVersions.id, to: r.questionAnswers.questionVersionId }),
      questionAttempts: r.many.questionAttempts({ from: r.questionVersions.id, to: r.questionAttempts.questionVersionId }),
      questionTruefalses: r.many.questionTruefalse({ from: r.questionVersions.id, to: r.questionTruefalse.questionVersionId }),
    },
    questionAnswers: {
      questionVersion: r.one.questionVersions({ from: r.questionAnswers.questionVersionId, to: r.questionVersions.id, optional: false }),
      questionTruefalseAsTrueAnswer: r.many.questionTruefalse({ from: r.questionAnswers.id, to: r.questionTruefalse.trueAnswer, alias: 'questionTruefalseAsTrueAnswer' }),
      questionTruefalseAsFalseAnswer: r.many.questionTruefalse({ from: r.questionAnswers.id, to: r.questionTruefalse.falseAnswer, alias: 'questionTruefalseAsFalseAnswer' }),
    },
    questionAnswerKeys: {
      questionVersion: r.one.questionVersions({ from: r.questionAnswerKeys.questionVersionId, to: r.questionVersions.id, optional: false }),
    },
    qtypeMultichoiceOptions: {
      questionVersion: r.one.questionVersions({ from: r.qtypeMultichoiceOptions.questionVersionId, to: r.questionVersions.id, optional: false }),
    },
    questionTruefalse: {
      questionVersion: r.one.questionVersions({ from: r.questionTruefalse.questionVersionId, to: r.questionVersions.id, optional: false }),
      trueAnswerRef: r.one.questionAnswers({ from: r.questionTruefalse.trueAnswer, to: r.questionAnswers.id, optional: false, alias: 'trueAnswerRef' }),
      falseAnswerRef: r.one.questionAnswers({ from: r.questionTruefalse.falseAnswer, to: r.questionAnswers.id, optional: false, alias: 'falseAnswerRef' }),
    },
    qtypeShortanswerOptions: {
      questionVersion: r.one.questionVersions({ from: r.qtypeShortanswerOptions.questionVersionId, to: r.questionVersions.id, optional: false }),
    },
    qtypeEssayOptions: {
      questionVersion: r.one.questionVersions({ from: r.qtypeEssayOptions.questionVersionId, to: r.questionVersions.id, optional: false }),
    },
    questionUsages: {
      examAttempts: r.many.examAttempts({ from: r.questionUsages.id, to: r.examAttempts.usageId }),
      questionAttempts: r.many.questionAttempts({ from: r.questionUsages.id, to: r.questionAttempts.questionUsageId }),
    },
    questionAttempts: {
      questionUsage: r.one.questionUsages({ from: r.questionAttempts.questionUsageId, to: r.questionUsages.id, optional: false }),
      question: r.one.question({ from: r.questionAttempts.questionId, to: r.question.id, optional: false }),
      questionVersion: r.one.questionVersions({ from: r.questionAttempts.questionVersionId, to: r.questionVersions.id }),
      examAttemptRegradeItems: r.many.examAttemptRegradeItems({ from: r.questionAttempts.id, to: r.examAttemptRegradeItems.questionAttemptId }),
      questionAttemptSteps: r.many.questionAttemptSteps({ from: r.questionAttempts.id, to: r.questionAttemptSteps.questionAttemptId }),
    },
    questionAttemptSteps: {
      questionAttempt: r.one.questionAttempts({ from: r.questionAttemptSteps.questionAttemptId, to: r.questionAttempts.id, optional: false }),
      questionAttemptStepData: r.many.questionAttemptStepData({ from: r.questionAttemptSteps.id, to: r.questionAttemptStepData.attemptStepId }),
    },
    questionAttemptStepData: {
      attemptStep: r.one.questionAttemptSteps({ from: r.questionAttemptStepData.attemptStepId, to: r.questionAttemptSteps.id, optional: false }),
    },
    // ── exams.schema.ts — Đề thi ──
    exams: {
      tenant: r.one.tenants({ from: r.exams.tenantId, to: r.tenants.id }),
      bank: r.one.questionBanks({ from: r.exams.bankId, to: r.questionBanks.id, optional: false }),
      examContributions: r.many.examContributions({ from: r.exams.id, to: r.examContributions.examId }),
      examDossiers: r.many.examDossiers({ from: r.exams.id, to: r.examDossiers.examId }),
      examPins: r.many.examPins({ from: r.exams.id, to: r.examPins.examId }),
      examVersions: r.many.examVersions({ from: r.exams.id, to: r.examVersions.examId }),
    },
    examVersions: {
      exam: r.one.exams({ from: r.examVersions.examId, to: r.exams.id, optional: false }),
      subject: r.one.subjects({ from: r.examVersions.subjectId, to: r.subjects.id }),
      matrix: r.one.examMatrices({ from: r.examVersions.matrixId, to: r.examMatrices.id }),
      matrixVersionRef: r.one.examMatrixVersions({ from: r.examVersions.matrixVersionId, to: r.examMatrixVersions.id }),
      examContributions: r.many.examContributions({ from: r.examVersions.id, to: r.examContributions.dossierExamVersionId }),
      examDossiers: r.many.examDossiers({ from: r.examVersions.id, to: r.examDossiers.examVersionId }),
      examPinVersionUpdatesAsFromExamVersion: r.many.examPinVersionUpdates({ from: r.examVersions.id, to: r.examPinVersionUpdates.fromExamVersionId, alias: 'examPinVersionUpdatesAsFromExamVersion' }),
      examPinVersionUpdatesAsToExamVersion: r.many.examPinVersionUpdates({ from: r.examVersions.id, to: r.examPinVersionUpdates.toExamVersionId, alias: 'examPinVersionUpdatesAsToExamVersion' }),
      examPins: r.many.examPins({ from: r.examVersions.id, to: r.examPins.examVersionId }),
      examSlots: r.many.examSlots({ from: r.examVersions.id, to: r.examSlots.examVersionId }),
    },
    examSlots: {
      examVersion: r.one.examVersions({ from: r.examSlots.examVersionId, to: r.examVersions.id, optional: false }),
      question: r.one.question({ from: r.examSlots.questionId, to: r.question.id, optional: false }),
      matrixCell: r.one.examMatrixCells({ from: r.examSlots.matrixCellId, to: r.examMatrixCells.id }),
    },
    examContributions: {
      exam: r.one.exams({ from: r.examContributions.examId, to: r.exams.id, optional: false }),
      targetBank: r.one.questionBanks({ from: r.examContributions.targetBankId, to: r.questionBanks.id, optional: false }),
      dossierExamVersion: r.one.examVersions({ from: r.examContributions.dossierExamVersionId, to: r.examVersions.id }),
      dossierMatrix: r.one.examMatrices({ from: r.examContributions.dossierMatrixId, to: r.examMatrices.id }),
      dossierMatrixVersionRef: r.one.examMatrixVersions({ from: r.examContributions.dossierMatrixVersionId, to: r.examMatrixVersions.id }),
      sourceDossier: r.one.examDossiers({ from: r.examContributions.sourceDossierId, to: r.examDossiers.id }),
      examContributionReviews: r.many.examContributionReviews({ from: r.examContributions.id, to: r.examContributionReviews.contributionId }),
    },
    examContributionReviews: {
      contribution: r.one.examContributions({ from: r.examContributionReviews.contributionId, to: r.examContributions.id, optional: false }),
    },
    examDossiers: {
      exam: r.one.exams({ from: r.examDossiers.examId, to: r.exams.id, optional: false }),
      targetBank: r.one.questionBanks({ from: r.examDossiers.targetBankId, to: r.questionBanks.id, optional: false }),
      examVersion: r.one.examVersions({ from: r.examDossiers.examVersionId, to: r.examVersions.id }),
      matrix: r.one.examMatrices({ from: r.examDossiers.matrixId, to: r.examMatrices.id }),
      matrixVersionRef: r.one.examMatrixVersions({ from: r.examDossiers.matrixVersionId, to: r.examMatrixVersions.id }),
      examContributions: r.many.examContributions({ from: r.examDossiers.id, to: r.examContributions.sourceDossierId }),
      examDossierReviews: r.many.examDossierReviews({ from: r.examDossiers.id, to: r.examDossierReviews.dossierId }),
    },
    examDossierReviews: {
      dossier: r.one.examDossiers({ from: r.examDossierReviews.dossierId, to: r.examDossiers.id, optional: false }),
    },
    // ── quiz.schema.ts — Lượt thi & ma trận đề ──
    examMatrices: {
      tenant: r.one.tenants({ from: r.examMatrices.tenantId, to: r.tenants.id }),
      subject: r.one.subjects({ from: r.examMatrices.subjectId, to: r.subjects.id, optional: false }),
      curriculum: r.one.curricula({ from: r.examMatrices.curriculumId, to: r.curricula.id, optional: false }),
      bank: r.one.questionBanks({ from: r.examMatrices.bankId, to: r.questionBanks.id }),
      examContributions: r.many.examContributions({ from: r.examMatrices.id, to: r.examContributions.dossierMatrixId }),
      examDossiers: r.many.examDossiers({ from: r.examMatrices.id, to: r.examDossiers.matrixId }),
      examMatrixCells: r.many.examMatrixCells({ from: r.examMatrices.id, to: r.examMatrixCells.matrixId }),
      examMatrixContributions: r.many.examMatrixContributions({ from: r.examMatrices.id, to: r.examMatrixContributions.matrixId }),
      examMatrixVersions: r.many.examMatrixVersions({ from: r.examMatrices.id, to: r.examMatrixVersions.matrixId }),
      examVersions: r.many.examVersions({ from: r.examMatrices.id, to: r.examVersions.matrixId }),
    },
    examMatrixVersions: {
      matrix: r.one.examMatrices({ from: r.examMatrixVersions.matrixId, to: r.examMatrices.id, optional: false }),
      examContributions: r.many.examContributions({ from: r.examMatrixVersions.id, to: r.examContributions.dossierMatrixVersionId }),
      examDossiers: r.many.examDossiers({ from: r.examMatrixVersions.id, to: r.examDossiers.matrixVersionId }),
      examMatrixCells: r.many.examMatrixCells({ from: r.examMatrixVersions.id, to: r.examMatrixCells.matrixVersionId }),
      examVersions: r.many.examVersions({ from: r.examMatrixVersions.id, to: r.examVersions.matrixVersionId }),
    },
    examMatrixCells: {
      matrix: r.one.examMatrices({ from: r.examMatrixCells.matrixId, to: r.examMatrices.id, optional: false }),
      matrixVersion: r.one.examMatrixVersions({ from: r.examMatrixCells.matrixVersionId, to: r.examMatrixVersions.id, optional: false }),
      curriculumNode: r.one.curriculumNodes({ from: r.examMatrixCells.curriculumNodeId, to: r.curriculumNodes.id, optional: false }),
      examSlots: r.many.examSlots({ from: r.examMatrixCells.id, to: r.examSlots.matrixCellId }),
    },
    examMatrixContributions: {
      matrix: r.one.examMatrices({ from: r.examMatrixContributions.matrixId, to: r.examMatrices.id, optional: false }),
      targetBank: r.one.questionBanks({ from: r.examMatrixContributions.targetBankId, to: r.questionBanks.id, optional: false }),
    },
    examPins: {
      exam: r.one.exams({ from: r.examPins.examId, to: r.exams.id, optional: false }),
      examVersion: r.one.examVersions({ from: r.examPins.examVersionId, to: r.examVersions.id, optional: false }),
      course: r.one.course({ from: r.examPins.courseId, to: r.course.id, optional: false }),
      targetGroup: r.one.courseGroups({ from: r.examPins.targetGroupId, to: r.courseGroups.id }),
      examAttemptRegrades: r.many.examAttemptRegrades({ from: r.examPins.id, to: r.examAttemptRegrades.pinId }),
      examAttempts: r.many.examAttempts({ from: r.examPins.id, to: r.examAttempts.pinId }),
      examBatches: r.many.examBatches({ from: r.examPins.id, to: r.examBatches.examPinId }),
      examPinFeedbacks: r.many.examPinFeedbacks({ from: r.examPins.id, to: r.examPinFeedbacks.pinId }),
      examPinOverrides: r.many.examPinOverrides({ from: r.examPins.id, to: r.examPinOverrides.pinId }),
      examPinVersionUpdates: r.many.examPinVersionUpdates({ from: r.examPins.id, to: r.examPinVersionUpdates.pinId }),
      examScans: r.many.examScans({ from: r.examPins.id, to: r.examScans.examPinId }),
    },
    examPinOverrides: {
      pin: r.one.examPins({ from: r.examPinOverrides.pinId, to: r.examPins.id, optional: false }),
      group: r.one.courseGroups({ from: r.examPinOverrides.groupId, to: r.courseGroups.id }),
    },
    examAttempts: {
      pin: r.one.examPins({ from: r.examAttempts.pinId, to: r.examPins.id, optional: false }),
      usage: r.one.questionUsages({ from: r.examAttempts.usageId, to: r.questionUsages.id, optional: false }),
      examAttemptEvents: r.many.examAttemptEvents({ from: r.examAttempts.id, to: r.examAttemptEvents.attemptId }),
      examAttemptRegradeItems: r.many.examAttemptRegradeItems({ from: r.examAttempts.id, to: r.examAttemptRegradeItems.examAttemptId }),
      examScans: r.many.examScans({ from: r.examAttempts.id, to: r.examScans.attemptId }),
    },
    examPinFeedbacks: {
      pin: r.one.examPins({ from: r.examPinFeedbacks.pinId, to: r.examPins.id, optional: false }),
    },
    examAttemptEvents: {
      attempt: r.one.examAttempts({ from: r.examAttemptEvents.attemptId, to: r.examAttempts.id, optional: false }),
    },
    examPinVersionUpdates: {
      pin: r.one.examPins({ from: r.examPinVersionUpdates.pinId, to: r.examPins.id, optional: false }),
      fromExamVersion: r.one.examVersions({ from: r.examPinVersionUpdates.fromExamVersionId, to: r.examVersions.id, optional: false, alias: 'fromExamVersion' }),
      toExamVersion: r.one.examVersions({ from: r.examPinVersionUpdates.toExamVersionId, to: r.examVersions.id, optional: false, alias: 'toExamVersion' }),
    },
    examAttemptRegrades: {
      pin: r.one.examPins({ from: r.examAttemptRegrades.pinId, to: r.examPins.id, optional: false }),
      question: r.one.question({ from: r.examAttemptRegrades.questionId, to: r.question.id, optional: false }),
      fromVersion: r.one.questionVersions({ from: r.examAttemptRegrades.fromVersionId, to: r.questionVersions.id, optional: false, alias: 'fromVersion' }),
      toVersion: r.one.questionVersions({ from: r.examAttemptRegrades.toVersionId, to: r.questionVersions.id, optional: false, alias: 'toVersion' }),
      examAttemptRegradeItems: r.many.examAttemptRegradeItems({ from: r.examAttemptRegrades.id, to: r.examAttemptRegradeItems.regradeId }),
    },
    examAttemptRegradeItems: {
      regrade: r.one.examAttemptRegrades({ from: r.examAttemptRegradeItems.regradeId, to: r.examAttemptRegrades.id, optional: false }),
      examAttempt: r.one.examAttempts({ from: r.examAttemptRegradeItems.examAttemptId, to: r.examAttempts.id, optional: false }),
      questionAttempt: r.one.questionAttempts({ from: r.examAttemptRegradeItems.questionAttemptId, to: r.questionAttempts.id, optional: false }),
    },
    // ── paper-grading.schema.ts — Chấm thi giấy ──
    examBatches: {
      examPin: r.one.examPins({ from: r.examBatches.examPinId, to: r.examPins.id, optional: false }),
      examScans: r.many.examScans({ from: r.examBatches.id, to: r.examScans.batchId }),
    },
    examScans: {
      batch: r.one.examBatches({ from: r.examScans.batchId, to: r.examBatches.id }),
      examPin: r.one.examPins({ from: r.examScans.examPinId, to: r.examPins.id, optional: false }),
      attempt: r.one.examAttempts({ from: r.examScans.attemptId, to: r.examAttempts.id }),
    },
    // ── assignments.schema.ts — Bài tập ──
    assignments: {
      courseRef: r.one.course({ from: r.assignments.course, to: r.course.id, optional: false }),
      assignGrades: r.many.assignGrades({ from: r.assignments.id, to: r.assignGrades.assignmentId }),
      assignRubrics: r.many.assignRubrics({ from: r.assignments.id, to: r.assignRubrics.assignmentId }),
      assignSubmissions: r.many.assignSubmissions({ from: r.assignments.id, to: r.assignSubmissions.assignmentId }),
    },
    assignSubmissions: {
      assignment: r.one.assignments({ from: r.assignSubmissions.assignmentId, to: r.assignments.id, optional: false }),
      assignAnnotations: r.many.assignAnnotations({ from: r.assignSubmissions.id, to: r.assignAnnotations.submissionId }),
      assignSubmissionFiles: r.many.assignSubmissionFiles({ from: r.assignSubmissions.id, to: r.assignSubmissionFiles.submissionId }),
    },
    assignSubmissionFiles: {
      submission: r.one.assignSubmissions({ from: r.assignSubmissionFiles.submissionId, to: r.assignSubmissions.id, optional: false }),
      file: r.one.files({ from: r.assignSubmissionFiles.fileId, to: r.files.id, optional: false }),
    },
    assignGrades: {
      assignment: r.one.assignments({ from: r.assignGrades.assignmentId, to: r.assignments.id, optional: false }),
      assignFeedbackMessages: r.many.assignFeedbackMessages({ from: r.assignGrades.id, to: r.assignFeedbackMessages.gradeId }),
      assignGradeRevisions: r.many.assignGradeRevisions({ from: r.assignGrades.id, to: r.assignGradeRevisions.gradeId }),
      assignRubricEvaluations: r.many.assignRubricEvaluations({ from: r.assignGrades.id, to: r.assignRubricEvaluations.gradeId }),
    },
    assignAnnotations: {
      submission: r.one.assignSubmissions({ from: r.assignAnnotations.submissionId, to: r.assignSubmissions.id, optional: false }),
      file: r.one.files({ from: r.assignAnnotations.fileId, to: r.files.id, optional: false }),
    },
    assignRubrics: {
      assignment: r.one.assignments({ from: r.assignRubrics.assignmentId, to: r.assignments.id, optional: false }),
      assignRubricCriteria: r.many.assignRubricCriteria({ from: r.assignRubrics.id, to: r.assignRubricCriteria.rubricId }),
    },
    assignRubricCriteria: {
      rubric: r.one.assignRubrics({ from: r.assignRubricCriteria.rubricId, to: r.assignRubrics.id, optional: false }),
      assignRubricEvaluations: r.many.assignRubricEvaluations({ from: r.assignRubricCriteria.id, to: r.assignRubricEvaluations.criterionId }),
      assignRubricLevels: r.many.assignRubricLevels({ from: r.assignRubricCriteria.id, to: r.assignRubricLevels.criterionId }),
    },
    assignRubricLevels: {
      criterion: r.one.assignRubricCriteria({ from: r.assignRubricLevels.criterionId, to: r.assignRubricCriteria.id, optional: false }),
      assignRubricEvaluations: r.many.assignRubricEvaluations({ from: r.assignRubricLevels.id, to: r.assignRubricEvaluations.levelId }),
    },
    assignRubricEvaluations: {
      grade: r.one.assignGrades({ from: r.assignRubricEvaluations.gradeId, to: r.assignGrades.id, optional: false }),
      criterion: r.one.assignRubricCriteria({ from: r.assignRubricEvaluations.criterionId, to: r.assignRubricCriteria.id, optional: false }),
      level: r.one.assignRubricLevels({ from: r.assignRubricEvaluations.levelId, to: r.assignRubricLevels.id }),
    },
    assignGradeRevisions: {
      grade: r.one.assignGrades({ from: r.assignGradeRevisions.gradeId, to: r.assignGrades.id, optional: false }),
    },
    assignFeedbackMessages: {
      grade: r.one.assignGrades({ from: r.assignFeedbackMessages.gradeId, to: r.assignGrades.id, optional: false }),
    },
    // ── content.schema.ts — Nội dung khoá học ──
    pages: {
      courseRef: r.one.course({ from: r.pages.course, to: r.course.id, optional: false }),
    },
    resources: {
      courseRef: r.one.course({ from: r.resources.course, to: r.course.id, optional: false }),
      file: r.one.files({ from: r.resources.fileId, to: r.files.id }),
    },
    courseLastAccess: {
      course: r.one.course({ from: r.courseLastAccess.courseId, to: r.course.id, optional: false }),
      cm: r.one.courseModules({ from: r.courseLastAccess.cmId, to: r.courseModules.id, optional: false }),
    },
    courseModuleProgress: {
      course: r.one.course({ from: r.courseModuleProgress.courseId, to: r.course.id, optional: false }),
      cm: r.one.courseModules({ from: r.courseModuleProgress.cmId, to: r.courseModules.id, optional: false }),
    },
    // ── curriculum.schema.ts — Chương trình & chuẩn đầu ra ──
    subjects: {
      books: r.many.books({ from: r.subjects.id, to: r.books.subjectId }),
      contentBankContents: r.many.contentBankContent({ from: r.subjects.id, to: r.contentBankContent.subjectId }),
      courses: r.many.course({ from: r.subjects.id, to: r.course.subjectId }),
      curricula: r.many.curricula({ from: r.subjects.id, to: r.curricula.subjectId }),
      curriculumProgramRecords: r.many.curriculumProgramRecords({ from: r.subjects.id, to: r.curriculumProgramRecords.subjectId }),
      examMatrices: r.many.examMatrices({ from: r.subjects.id, to: r.examMatrices.subjectId }),
      examVersions: r.many.examVersions({ from: r.subjects.id, to: r.examVersions.subjectId }),
      questionSubjects: r.many.questionSubjects({ from: r.subjects.id, to: r.questionSubjects.subjectId }),
    },
    curricula: {
      subject: r.one.subjects({ from: r.curricula.subjectId, to: r.subjects.id, optional: false }),
      courseSectionAnchors: r.many.courseSectionAnchors({ from: r.curricula.id, to: r.courseSectionAnchors.curriculumId }),
      curriculumNodes: r.many.curriculumNodes({ from: r.curricula.id, to: r.curriculumNodes.curriculumId }),
      curriculumProgramRecords: r.many.curriculumProgramRecords({ from: r.curricula.id, to: r.curriculumProgramRecords.curriculumId }),
      examMatrices: r.many.examMatrices({ from: r.curricula.id, to: r.examMatrices.curriculumId }),
    },
    curriculumNodes: {
      curriculum: r.one.curricula({ from: r.curriculumNodes.curriculumId, to: r.curricula.id, optional: false }),
      parent: r.one.curriculumNodes({ from: [r.curriculumNodes.curriculumId, r.curriculumNodes.parentId], to: [r.curriculumNodes.curriculumId, r.curriculumNodes.id], alias: 'parent' }),
      bookMappings: r.many.bookMappings({ from: r.curriculumNodes.id, to: r.bookMappings.curriculumNodeId }),
      contentBankContents: r.many.contentBankContent({ from: r.curriculumNodes.id, to: r.contentBankContent.curriculumNodeId }),
      courseSectionAnchors: r.many.courseSectionAnchors({ from: r.curriculumNodes.id, to: r.courseSectionAnchors.nodeId }),
      children: r.many.curriculumNodes({ from: [r.curriculumNodes.curriculumId, r.curriculumNodes.id], to: [r.curriculumNodes.curriculumId, r.curriculumNodes.parentId], alias: 'children' }),
      curriculumProgramRecords: r.many.curriculumProgramRecords({ from: r.curriculumNodes.id, to: r.curriculumProgramRecords.nodeId }),
      examMatrixCells: r.many.examMatrixCells({ from: r.curriculumNodes.id, to: r.examMatrixCells.curriculumNodeId }),
      learningOutcomes: r.many.learningOutcomes({ from: r.curriculumNodes.id, to: r.learningOutcomes.nodeId }),
    },
    learningOutcomes: {
      tenant: r.one.tenants({ from: r.learningOutcomes.tenantId, to: r.tenants.id }),
      node: r.one.curriculumNodes({ from: r.learningOutcomes.nodeId, to: r.curriculumNodes.id, optional: false }),
      derivedFrom: r.one.learningOutcomes({ from: r.learningOutcomes.derivedFromId, to: r.learningOutcomes.id, alias: 'derivedFrom' }),
      bookMappings: r.many.bookMappings({ from: r.learningOutcomes.id, to: r.bookMappings.learningOutcomeId }),
      courseSectionAnchorOutcomes: r.many.courseSectionAnchorOutcomes({ from: r.learningOutcomes.id, to: r.courseSectionAnchorOutcomes.outcomeId }),
      courseSectionBookItemOutcomes: r.many.courseSectionBookItemOutcomes({ from: r.learningOutcomes.id, to: r.courseSectionBookItemOutcomes.outcomeId }),
      derivedOutcomes: r.many.learningOutcomes({ from: r.learningOutcomes.id, to: r.learningOutcomes.derivedFromId, alias: 'derivedOutcomes' }),
      questionLearningOutcomes: r.many.questionLearningOutcomes({ from: r.learningOutcomes.id, to: r.questionLearningOutcomes.learningOutcomeId }),
    },
    questionSubjects: {
      question: r.one.question({ from: r.questionSubjects.questionId, to: r.question.id, optional: false }),
      subject: r.one.subjects({ from: r.questionSubjects.subjectId, to: r.subjects.id, optional: false }),
    },
    questionLearningOutcomes: {
      question: r.one.question({ from: r.questionLearningOutcomes.questionId, to: r.question.id, optional: false }),
      learningOutcome: r.one.learningOutcomes({ from: r.questionLearningOutcomes.learningOutcomeId, to: r.learningOutcomes.id, optional: false }),
    },
    curriculumProgramRecords: {
      subject: r.one.subjects({ from: r.curriculumProgramRecords.subjectId, to: r.subjects.id, optional: false }),
      curriculum: r.one.curricula({ from: r.curriculumProgramRecords.curriculumId, to: r.curricula.id, optional: false }),
      node: r.one.curriculumNodes({ from: r.curriculumProgramRecords.nodeId, to: r.curriculumNodes.id, optional: false }),
    },
    // ── books.schema.ts — Sách ──
    books: {
      subject: r.one.subjects({ from: r.books.subjectId, to: r.subjects.id }),
      bookNodes: r.many.bookNodes({ from: r.books.id, to: r.bookNodes.bookId }),
      bookRecords: r.many.bookRecords({ from: r.books.id, to: r.bookRecords.bookId }),
      courseSectionBookAnchors: r.many.courseSectionBookAnchors({ from: r.books.id, to: r.courseSectionBookAnchors.bookId }),
    },
    bookNodes: {
      book: r.one.books({ from: r.bookNodes.bookId, to: r.books.id, optional: false }),
      parent: r.one.bookNodes({ from: [r.bookNodes.bookId, r.bookNodes.parentId], to: [r.bookNodes.bookId, r.bookNodes.id], alias: 'parent' }),
      bookMappings: r.many.bookMappings({ from: r.bookNodes.id, to: r.bookMappings.bookNodeId }),
      children: r.many.bookNodes({ from: [r.bookNodes.bookId, r.bookNodes.id], to: [r.bookNodes.bookId, r.bookNodes.parentId], alias: 'children' }),
      bookRecords: r.many.bookRecords({ from: r.bookNodes.id, to: r.bookRecords.nodeId }),
      courseSectionBookAnchors: r.many.courseSectionBookAnchors({ from: r.bookNodes.id, to: r.courseSectionBookAnchors.bookNodeId }),
      courseSectionBookItems: r.many.courseSectionBookItems({ from: r.bookNodes.id, to: r.courseSectionBookItems.bookNodeId }),
    },
    bookMappings: {
      bookNode: r.one.bookNodes({ from: r.bookMappings.bookNodeId, to: r.bookNodes.id, optional: false }),
      curriculumNode: r.one.curriculumNodes({ from: r.bookMappings.curriculumNodeId, to: r.curriculumNodes.id }),
      learningOutcome: r.one.learningOutcomes({ from: r.bookMappings.learningOutcomeId, to: r.learningOutcomes.id }),
    },
    bookRecords: {
      book: r.one.books({ from: r.bookRecords.bookId, to: r.books.id, optional: false }),
      node: r.one.bookNodes({ from: r.bookRecords.nodeId, to: r.bookNodes.id, optional: false }),
    },
    // ── messaging.schema.ts — Nhắn tin & thông báo ──
    messageConversations: {
      tenant: r.one.tenants({ from: r.messageConversations.tenantId, to: r.tenants.id }),
      messages: r.many.message({ from: r.messageConversations.id, to: r.message.conversationId }),
      messageConversationMembers: r.many.messageConversationMembers({ from: r.messageConversations.id, to: r.messageConversationMembers.conversationId }),
      messageConversationReports: r.many.messageConversationReports({ from: r.messageConversations.id, to: r.messageConversationReports.conversationId }),
    },
    messageConversationMembers: {
      conversation: r.one.messageConversations({ from: r.messageConversationMembers.conversationId, to: r.messageConversations.id, optional: false }),
    },
    message: {
      conversation: r.one.messageConversations({ from: r.message.conversationId, to: r.messageConversations.id, optional: false }),
      replyToMessage: r.one.message({ from: r.message.replyToMessageId, to: r.message.id, alias: 'replyToMessage' }),
      replies: r.many.message({ from: r.message.id, to: r.message.replyToMessageId, alias: 'replies' }),
      messageUserDeletions: r.many.messageUserDeletions({ from: r.message.id, to: r.messageUserDeletions.messageId }),
    },
    messageUserDeletions: {
      message: r.one.message({ from: r.messageUserDeletions.messageId, to: r.message.id, optional: false }),
    },
    messageConversationReports: {
      conversation: r.one.messageConversations({ from: r.messageConversationReports.conversationId, to: r.messageConversations.id, optional: false }),
    },
    notifications: {
      tenant: r.one.tenants({ from: r.notifications.tenantId, to: r.tenants.id }),
    },
    notificationDispatchLog: {
      tenant: r.one.tenants({ from: r.notificationDispatchLog.tenantId, to: r.tenants.id }),
    },
    // ── badges.schema.ts — Huy hiệu ──
    badge: {
      badgeCriteria: r.many.badgeCriteria({ from: r.badge.id, to: r.badgeCriteria.badgeId }),
      badgeIssueds: r.many.badgeIssued({ from: r.badge.id, to: r.badgeIssued.badgeId }),
      badgeManualAwards: r.many.badgeManualAward({ from: r.badge.id, to: r.badgeManualAward.badgeId }),
    },
    badgeCriteria: {
      badge: r.one.badge({ from: r.badgeCriteria.badgeId, to: r.badge.id, optional: false }),
    },
    badgeIssued: {
      badge: r.one.badge({ from: r.badgeIssued.badgeId, to: r.badge.id, optional: false }),
    },
    badgeManualAward: {
      badge: r.one.badge({ from: r.badgeManualAward.badgeId, to: r.badge.id, optional: false }),
    },
    // ── competencies.schema.ts — Năng lực & kế hoạch học tập ──
    competencyFramework: {
      competencies: r.many.competency({ from: r.competencyFramework.id, to: r.competency.frameworkId }),
    },
    competency: {
      framework: r.one.competencyFramework({ from: r.competency.frameworkId, to: r.competencyFramework.id, optional: false }),
      competencyCourseComps: r.many.competencyCourseComp({ from: r.competency.id, to: r.competencyCourseComp.competencyId }),
      competencyModuleComps: r.many.competencyModuleComp({ from: r.competency.id, to: r.competencyModuleComp.competencyId }),
      competencyPlanComps: r.many.competencyPlanComp({ from: r.competency.id, to: r.competencyPlanComp.competencyId }),
      competencyTemplateComps: r.many.competencyTemplateComp({ from: r.competency.id, to: r.competencyTemplateComp.competencyId }),
      competencyUserComps: r.many.competencyUserComp({ from: r.competency.id, to: r.competencyUserComp.competencyId }),
    },
    competencyCourseComp: {
      competency: r.one.competency({ from: r.competencyCourseComp.competencyId, to: r.competency.id, optional: false }),
    },
    competencyModuleComp: {
      competency: r.one.competency({ from: r.competencyModuleComp.competencyId, to: r.competency.id, optional: false }),
    },
    competencyTemplate: {
      competencyTemplateCohorts: r.many.competencyTemplateCohort({ from: r.competencyTemplate.id, to: r.competencyTemplateCohort.templateId }),
      competencyTemplateComps: r.many.competencyTemplateComp({ from: r.competencyTemplate.id, to: r.competencyTemplateComp.templateId }),
    },
    competencyTemplateComp: {
      template: r.one.competencyTemplate({ from: r.competencyTemplateComp.templateId, to: r.competencyTemplate.id, optional: false }),
      competency: r.one.competency({ from: r.competencyTemplateComp.competencyId, to: r.competency.id, optional: false }),
    },
    competencyTemplateCohort: {
      template: r.one.competencyTemplate({ from: r.competencyTemplateCohort.templateId, to: r.competencyTemplate.id, optional: false }),
    },
    learningPlans: {
      competencyPlanComps: r.many.competencyPlanComp({ from: r.learningPlans.id, to: r.competencyPlanComp.planId }),
      competencyPlanReviews: r.many.competencyPlanReview({ from: r.learningPlans.id, to: r.competencyPlanReview.planId }),
    },
    competencyPlanComp: {
      plan: r.one.learningPlans({ from: r.competencyPlanComp.planId, to: r.learningPlans.id, optional: false }),
      competency: r.one.competency({ from: r.competencyPlanComp.competencyId, to: r.competency.id, optional: false }),
    },
    competencyPlanReview: {
      plan: r.one.learningPlans({ from: r.competencyPlanReview.planId, to: r.learningPlans.id, optional: false }),
    },
    competencyUserComp: {
      competency: r.one.competency({ from: r.competencyUserComp.competencyId, to: r.competency.id, optional: false }),
      competencyEvidences: r.many.competencyEvidence({ from: r.competencyUserComp.id, to: r.competencyEvidence.userCompetencyId }),
    },
    competencyEvidence: {
      userCompetency: r.one.competencyUserComp({ from: r.competencyEvidence.userCompetencyId, to: r.competencyUserComp.id, optional: false }),
    },
    // ── social.schema.ts — Tương tác xã hội & thẻ ──
    tag: {
      correlation: r.one.tagCorrelation({ from: r.tag.id, to: r.tagCorrelation.tagId }),
      tagInstances: r.many.tagInstance({ from: r.tag.id, to: r.tagInstance.tagId }),
    },
    tagInstance: {
      tag: r.one.tag({ from: r.tagInstance.tagId, to: r.tag.id, optional: false }),
    },
    tagCorrelation: {
      tag: r.one.tag({ from: r.tagCorrelation.tagId, to: r.tag.id, optional: false }),
    },
    // ── integrations.schema.ts — Tích hợp ngoài ──
    externalServices: {
      externalTokens: r.many.externalTokens({ from: r.externalServices.id, to: r.externalTokens.serviceId }),
    },
    externalTokens: {
      service: r.one.externalServices({ from: r.externalTokens.serviceId, to: r.externalServices.id, optional: false }),
    },
    // ── backup.schema.ts — Sao lưu ──
    backupJobs: {
      backupIdMappings: r.many.backupIdMappings({ from: r.backupJobs.id, to: r.backupIdMappings.jobId }),
      backupJobSteps: r.many.backupJobSteps({ from: r.backupJobs.id, to: r.backupJobSteps.jobId }),
    },
    backupJobSteps: {
      job: r.one.backupJobs({ from: r.backupJobSteps.jobId, to: r.backupJobs.id, optional: false }),
    },
    backupIdMappings: {
      job: r.one.backupJobs({ from: r.backupIdMappings.jobId, to: r.backupJobs.id, optional: false }),
    },
    // ── analytics.schema.ts — Phân tích ──
    analyticsModels: {
      analyticsPredictions: r.many.analyticsPredictions({ from: r.analyticsModels.id, to: r.analyticsPredictions.modelId }),
      insights: r.many.insights({ from: r.analyticsModels.id, to: r.insights.modelId }),
    },
    analyticsPredictions: {
      model: r.one.analyticsModels({ from: r.analyticsPredictions.modelId, to: r.analyticsModels.id, optional: false }),
    },
    insights: {
      model: r.one.analyticsModels({ from: r.insights.modelId, to: r.analyticsModels.id, optional: false }),
    },
    // ── reports.schema.ts — Báo cáo ──
    reportBuilderReport: {
      reportBuilderAudiences: r.many.reportBuilderAudience({ from: r.reportBuilderReport.id, to: r.reportBuilderAudience.reportId }),
      reportBuilderSchedules: r.many.reportBuilderSchedule({ from: r.reportBuilderReport.id, to: r.reportBuilderSchedule.reportId }),
    },
    reportBuilderAudience: {
      report: r.one.reportBuilderReport({ from: r.reportBuilderAudience.reportId, to: r.reportBuilderReport.id, optional: false }),
    },
    reportBuilderSchedule: {
      report: r.one.reportBuilderReport({ from: r.reportBuilderSchedule.reportId, to: r.reportBuilderReport.id, optional: false }),
    },
    // ── content-bank.schema.ts — Ngân hàng nội dung ──
    contentBankContent: {
      subject: r.one.subjects({ from: r.contentBankContent.subjectId, to: r.subjects.id }),
      curriculumNode: r.one.curriculumNodes({ from: r.contentBankContent.curriculumNodeId, to: r.curriculumNodes.id }),
      questionCategory: r.one.questionCategories({ from: r.contentBankContent.questionCategoryId, to: r.questionCategories.id }),
      derivedFrom: r.one.contentBankContent({ from: r.contentBankContent.derivedFromId, to: r.contentBankContent.id, alias: 'derivedFrom' }),
      derivedContents: r.many.contentBankContent({ from: r.contentBankContent.id, to: r.contentBankContent.derivedFromId, alias: 'derivedContents' }),
    },
    // ── payments.schema.ts — Thanh toán ──
    paymentAccounts: {
      tenant: r.one.tenants({ from: r.paymentAccounts.tenantId, to: r.tenants.id, optional: false }),
      classes: r.many.classes({ from: r.paymentAccounts.id, to: r.classes.feePaymentAccountId }),
      paymentProviderEvents: r.many.paymentProviderEvents({ from: r.paymentAccounts.id, to: r.paymentProviderEvents.accountId }),
      payments: r.many.payments({ from: r.paymentAccounts.id, to: r.payments.accountId }),
    },
    payments: {
      account: r.one.paymentAccounts({ from: r.payments.accountId, to: r.paymentAccounts.id, optional: false }),
      tenant: r.one.tenants({ from: r.payments.tenantId, to: r.tenants.id, optional: false }),
      reviewHandledByRef: r.one.users({ from: r.payments.reviewHandledBy, to: r.users.id }),
      paymentProviderEvents: r.many.paymentProviderEvents({ from: r.payments.id, to: r.paymentProviderEvents.matchedPaymentId }),
      paymentRefunds: r.many.paymentRefunds({ from: r.payments.id, to: r.paymentRefunds.paymentId }),
      planEntitlements: r.many.planEntitlements({ from: r.payments.id, to: r.planEntitlements.paymentId }),
    },
    paymentRefunds: {
      payment: r.one.payments({ from: r.paymentRefunds.paymentId, to: r.payments.id, optional: false }),
      createdByRef: r.one.users({ from: r.paymentRefunds.createdBy, to: r.users.id, alias: 'createdByRef' }),
      approvedByRef: r.one.users({ from: r.paymentRefunds.approvedBy, to: r.users.id, alias: 'approvedByRef' }),
      rejectedByRef: r.one.users({ from: r.paymentRefunds.rejectedBy, to: r.users.id, alias: 'rejectedByRef' }),
      settledByRef: r.one.users({ from: r.paymentRefunds.settledBy, to: r.users.id, alias: 'settledByRef' }),
      settledEvent: r.one.paymentProviderEvents({ from: r.paymentRefunds.settledEventId, to: r.paymentProviderEvents.id }),
    },
    paymentProviderEvents: {
      tenant: r.one.tenants({ from: r.paymentProviderEvents.tenantId, to: r.tenants.id }),
      account: r.one.paymentAccounts({ from: r.paymentProviderEvents.accountId, to: r.paymentAccounts.id }),
      matchedPayment: r.one.payments({ from: r.paymentProviderEvents.matchedPaymentId, to: r.payments.id }),
      paymentRefunds: r.many.paymentRefunds({ from: r.paymentProviderEvents.id, to: r.paymentRefunds.settledEventId }),
    },
    planEntitlements: {
      tenant: r.one.tenants({ from: r.planEntitlements.tenantId, to: r.tenants.id, optional: false }),
      payment: r.one.payments({ from: r.planEntitlements.paymentId, to: r.payments.id, optional: false }),
    },
    paymentCoupons: {
      createdByRef: r.one.users({ from: r.paymentCoupons.createdBy, to: r.users.id }),
    },
    // ── privacy.schema.ts — Quyền riêng tư ──
    privacyRequests: {
      privacyExportFiles: r.many.privacyExportFiles({ from: r.privacyRequests.id, to: r.privacyExportFiles.requestId }),
    },
    privacyExportFiles: {
      request: r.one.privacyRequests({ from: r.privacyExportFiles.requestId, to: r.privacyRequests.id, optional: false }),
    },
}));
