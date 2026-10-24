import {
  deriveBlogAudience, type BlogAudience, type BlogSpaceType, type BlogStatus,
} from './blog-state';

/**
 * Di trú dữ liệu blog cũ → mô hình space/status của BL1 (issue #87).
 *
 * QUY TẮC BẤT BIẾN: audience sau di trú phải là tập con của audience
 * trước di trú — giữ nguyên hoặc thu hẹp, KHÔNG bài nào rộng ra.
 * Audience cũ (mô hình #48): tác giả + site admin; draft chỉ hai nhóm
 * đó; bài 'site' cần `blog:view` tại system, và nếu có association thì
 * viewer phải thuộc ÍT NHẤT MỘT khoá liên kết (course trực tiếp hoặc
 * qua module; association không phân giải được khoá thì fail-closed).
 *
 * Ánh xạ:
 * - draft → space cá nhân của tác giả, status 'draft', audience private.
 * - 'site' không association → space trường, status 'published'.
 * - 'site' có association phân giải được khoá: space chính = khoá ĐẦU
 *   TIÊN theo thứ tự association (id uuidv7 tăng dần theo thời gian
 *   tạo); các khoá còn lại ghi placement (placement không mở rộng
 *   audience ở BL1 nên hợp khoá cũ bị thu về khoá chính — thu hẹp,
 *   đúng quy tắc).
 * - 'site' chỉ có association KHÔNG phân giải được khoá (module đã
 *   xoá): giữ fail-closed như cũ — space 'course' với space_id null,
 *   canView chỉ cho tác giả/admin qua.
 */

export interface LegacyBlogPostInput {
  userId: string;
  publishState: string;
  created: Date;
}

export interface LegacyAssociationInput {
  assocType: string; // course | coursemodule
  assocId: string;
}

export interface BlogSpaceMigrationOutcome {
  spaceType: BlogSpaceType;
  spaceId: string | null;
  status: BlogStatus;
  audience: BlogAudience;
  /** Các khoá liên kết phụ (khác space chính) để ghi placement. */
  placementCourseIds: string[];
  /** Bài bị giữ fail-closed vì association không phân giải được khoá. */
  failClosed: boolean;
}

export function mapLegacyBlogPost(
  post: LegacyBlogPostInput,
  associations: readonly LegacyAssociationInput[],
  resolveModuleCourse: (moduleId: string) => string | null,
): BlogSpaceMigrationOutcome {
  if (post.publishState !== 'site') {
    return {
      spaceType: 'user', spaceId: post.userId, status: 'draft',
      audience: 'private', placementCourseIds: [], failClosed: false,
    };
  }
  const courseIds: string[] = [];
  let sawAssociation = false;
  for (const assoc of associations) {
    sawAssociation = true;
    if (assoc.assocType === 'course') {
      if (!courseIds.includes(assoc.assocId)) courseIds.push(assoc.assocId);
    } else if (assoc.assocType === 'coursemodule') {
      const courseId = resolveModuleCourse(assoc.assocId);
      if (courseId && !courseIds.includes(courseId)) courseIds.push(courseId);
    }
  }
  if (courseIds.length > 0) {
    const [primary, ...rest] = courseIds;
    return {
      spaceType: 'course', spaceId: primary!, status: 'published',
      audience: deriveBlogAudience('course', 'published'),
      placementCourseIds: rest, failClosed: false,
    };
  }
  if (sawAssociation) {
    // Có association nhưng không phân giải được khoá nào: fail-closed.
    return {
      spaceType: 'course', spaceId: null, status: 'published',
      audience: deriveBlogAudience('course', 'published'),
      placementCourseIds: [], failClosed: true,
    };
  }
  return {
    spaceType: 'school', spaceId: null, status: 'published',
    audience: deriveBlogAudience('school', 'published'),
    placementCourseIds: [], failClosed: false,
  };
}
