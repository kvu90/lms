/**
 * Khoá truy vấn của feature messaging (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  messagingGroupTree: ['messages', 'group-tree'] as const,
  messagingConversations: ['messages', 'conversations'] as const,
  messagingArchivedConversations: ['messages', 'conversations', 'archived'] as const,
  messagingBlockedContacts: ['messages', 'contacts', 'blocked'] as const,
  messagingContacts: ['messages', 'contacts'] as const,
  messagingContactRequests: ['messages', 'contacts', 'requests'] as const,
  messagingCourses: ['messages', 'courses'] as const,
  messagingConversationDetail: (conversationId: string) => ['messages', 'conversations', conversationId] as const,
  messagingMessagesPage: (conversationId: string, beforeSeq: number) =>
    ['messages', 'conversations', conversationId, 'messages', beforeSeq] as const,
  messagingSearch: (conversationId: string, q: string) => ['messages', 'conversations', conversationId, 'search', q] as const,
  messagingRosterPage: (url: string) => ['messages', 'roster', url] as const,
  messagingClassConversation: (classId: string) => ['messages', 'classes', classId, 'conversation'] as const,
  messagingPersonProfile: (userId: string) => ['messages', 'users', userId, 'profile'] as const,
};
