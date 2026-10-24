/**
 * State machine vòng đời bài blog (BL1, issue #87) — nguồn sự thật duy
 * nhất cho các giá trị enum và luật chuyển trạng thái. BlogService
 * validate ở CẢ create và update qua module này (lỗi cũ của mô hình hai
 * mức: update không validate lại `publishState`).
 */

export const BLOG_SPACE_TYPES = ['course', 'school', 'user'] as const;
export type BlogSpaceType = (typeof BLOG_SPACE_TYPES)[number];

export const BLOG_KINDS = ['article', 'resource', 'question'] as const;
export type BlogKind = (typeof BLOG_KINDS)[number];

export const BLOG_STATUSES = ['draft', 'pending_review', 'published', 'hidden', 'archived', 'deleted'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export const BLOG_AUDIENCES = ['private', 'course', 'school'] as const;
export type BlogAudience = (typeof BLOG_AUDIENCES)[number];

export const BLOG_MODERATION_STATES = ['clear', 'flagged', 'held', 'removed'] as const;
export type BlogModerationState = (typeof BLOG_MODERATION_STATES)[number];

export const BLOG_COMMENTS_POLICIES = ['open', 'moderated', 'closed'] as const;
export type BlogCommentsPolicy = (typeof BLOG_COMMENTS_POLICIES)[number];

export const BLOG_QUESTION_STATES = ['open', 'answered', 'resolved', 'closed'] as const;
export type BlogQuestionState = (typeof BLOG_QUESTION_STATES)[number];

export const BLOG_PLACEMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type BlogPlacementStatus = (typeof BLOG_PLACEMENT_STATUSES)[number];

export const BLOG_REF_TYPES = [
  'question_version', 'quiz', 'course', 'course_module', 'content_bank', 'file', 'external_url',
] as const;
export type BlogRefType = (typeof BLOG_REF_TYPES)[number];

/**
 * Luật chuyển trạng thái. `deleted` là trạng thái cuối (xoá mềm) — mọi
 * trạng thái đều đi được tới `deleted`, và không đi ra khỏi nó. `hidden`
 * chỉ do kiểm duyệt (BL4) hoặc tác giả rút bài; khôi phục hidden →
 * published. `archived` dành cho bài hết kỳ; mở lại về published.
 */
const TRANSITIONS: Record<BlogStatus, readonly BlogStatus[]> = {
  draft: ['pending_review', 'published', 'deleted'],
  pending_review: ['draft', 'published', 'deleted'],
  published: ['draft', 'hidden', 'archived', 'deleted'],
  hidden: ['published', 'archived', 'deleted'],
  archived: ['published', 'deleted'],
  deleted: [],
};

export function canTransitionBlogStatus(from: BlogStatus, to: BlogStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/**
 * Audience suy ra từ space + status: chỉ bài published/archived mới có
 * audience ngoài tác giả; còn lại là private. Space khoá → 'course';
 * space trường và space cá nhân đã xuất bản → 'school' (mọi người dùng
 * đã đăng nhập có `blog:view` — đúng tầm nhìn của bài `site` cá nhân
 * trong mô hình cũ; space vẫn phân biệt nơi bài sống).
 */
export function deriveBlogAudience(spaceType: BlogSpaceType, status: BlogStatus): BlogAudience {
  if (status !== 'published' && status !== 'archived') return 'private';
  return spaceType === 'course' ? 'course' : 'school';
}

/** Ánh xạ tương thích ngược cho client cũ (web BL2 chưa chuyển): chỉ bài published mới là 'site'. */
export function legacyPublishState(status: BlogStatus): 'draft' | 'site' {
  return status === 'published' ? 'site' : 'draft';
}

/** Ánh xạ input tương thích ngược: publishState cũ → status mới. */
export function statusFromLegacyPublishState(publishState: string): BlogStatus {
  return publishState === 'site' ? 'published' : 'draft';
}
