import { describe, expect, it } from 'vitest';
import { mapLegacyBlogPost } from './blog-migration';

/**
 * Ánh xạ di trú blog cũ → mô hình space (BL1, issue #87). Quy tắc bất
 * biến: audience sau di trú ⊆ audience trước — các ca dưới đây khoá
 * từng nhánh ánh xạ, đặc biệt các ca thu hẹp/fail-closed.
 */
describe('blog-migration: ánh xạ bài cũ', () => {
  const author = 'user-author';
  const created = new Date('2026-01-01T00:00:00Z');
  const noModule = () => null;

  it('draft → space cá nhân của tác giả, private, bỏ qua association', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'draft', created },
      [{ assocType: 'course', assocId: 'course-a' }],
      noModule,
    );
    expect(out).toEqual({
      spaceType: 'user', spaceId: author, status: 'draft',
      audience: 'private', placementCourseIds: [], failClosed: false,
    });
  });

  it('site không association → space trường, published, audience school', () => {
    const out = mapLegacyBlogPost({ userId: author, publishState: 'site', created }, [], noModule);
    expect(out.spaceType).toBe('school');
    expect(out.spaceId).toBeNull();
    expect(out.status).toBe('published');
    expect(out.audience).toBe('school');
    expect(out.failClosed).toBe(false);
  });

  it('site gắn một khoá → space khoá đó', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'site', created },
      [{ assocType: 'course', assocId: 'course-a' }],
      noModule,
    );
    expect(out.spaceType).toBe('course');
    expect(out.spaceId).toBe('course-a');
    expect(out.audience).toBe('course');
    expect(out.placementCourseIds).toEqual([]);
  });

  it('site gắn nhiều khoá → khoá đầu tiên là space chính, phần còn lại thành placement (thu hẹp hợp khoá cũ)', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'site', created },
      [
        { assocType: 'course', assocId: 'course-a' },
        { assocType: 'course', assocId: 'course-b' },
        { assocType: 'course', assocId: 'course-a' },
        { assocType: 'course', assocId: 'course-c' },
      ],
      noModule,
    );
    expect(out.spaceId).toBe('course-a');
    expect(out.placementCourseIds).toEqual(['course-b', 'course-c']);
  });

  it('association qua module phân giải về khoá chứa module', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'site', created },
      [{ assocType: 'coursemodule', assocId: 'cm-1' }],
      (id) => (id === 'cm-1' ? 'course-m' : null),
    );
    expect(out.spaceType).toBe('course');
    expect(out.spaceId).toBe('course-m');
    expect(out.failClosed).toBe(false);
  });

  it('trộn course + module: thứ tự association quyết định space chính', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'site', created },
      [
        { assocType: 'coursemodule', assocId: 'cm-1' },
        { assocType: 'course', assocId: 'course-a' },
      ],
      () => 'course-m',
    );
    expect(out.spaceId).toBe('course-m');
    expect(out.placementCourseIds).toEqual(['course-a']);
  });

  it('chỉ có association không phân giải được → fail-closed: space course với space_id null', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'site', created },
      [{ assocType: 'coursemodule', assocId: 'cm-đã-xoá' }],
      noModule,
    );
    expect(out.spaceType).toBe('course');
    expect(out.spaceId).toBeNull();
    expect(out.status).toBe('published');
    expect(out.failClosed).toBe(true);
  });

  it('association lạ (không phải course/coursemodule) mà không có khoá nào → fail-closed thay vì mở ra trường', () => {
    const out = mapLegacyBlogPost(
      { userId: author, publishState: 'site', created },
      [{ assocType: 'user', assocId: 'ai-đó' }],
      noModule,
    );
    expect(out.failClosed).toBe(true);
    expect(out.spaceId).toBeNull();
  });
});
