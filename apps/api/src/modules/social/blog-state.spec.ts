import { describe, expect, it } from 'vitest';
import {
  canTransitionBlogStatus, deriveBlogAudience, legacyPublishState, statusFromLegacyPublishState,
} from './blog-state';

/**
 * State machine vòng đời bài blog (BL1, issue #87): bảng chuyển trạng
 * thái + suy audience từ space/status là logic thuần — kiểm chứng
 * không cần DB.
 */
describe('blog-state: chuyển trạng thái', () => {
  it('cho phép các chuyển hợp lệ của vòng đời chuẩn', () => {
    expect(canTransitionBlogStatus('draft', 'pending_review')).toBe(true);
    expect(canTransitionBlogStatus('draft', 'published')).toBe(true);
    expect(canTransitionBlogStatus('pending_review', 'draft')).toBe(true);
    expect(canTransitionBlogStatus('pending_review', 'published')).toBe(true);
    expect(canTransitionBlogStatus('published', 'hidden')).toBe(true);
    expect(canTransitionBlogStatus('hidden', 'published')).toBe(true);
    expect(canTransitionBlogStatus('published', 'archived')).toBe(true);
    expect(canTransitionBlogStatus('archived', 'published')).toBe(true);
    expect(canTransitionBlogStatus('published', 'draft')).toBe(true);
  });

  it('mọi trạng thái đều xoá mềm được, deleted là trạng thái cuối', () => {
    for (const from of ['draft', 'pending_review', 'published', 'hidden', 'archived'] as const) {
      expect(canTransitionBlogStatus(from, 'deleted')).toBe(true);
    }
    expect(canTransitionBlogStatus('deleted', 'published')).toBe(false);
    expect(canTransitionBlogStatus('deleted', 'draft')).toBe(false);
    expect(canTransitionBlogStatus('deleted', 'deleted')).toBe(true);
  });

  it('chặn các chuyển ngược vòng đời', () => {
    expect(canTransitionBlogStatus('draft', 'hidden')).toBe(false);
    expect(canTransitionBlogStatus('draft', 'archived')).toBe(false);
    expect(canTransitionBlogStatus('pending_review', 'hidden')).toBe(false);
    expect(canTransitionBlogStatus('archived', 'draft')).toBe(false);
    expect(canTransitionBlogStatus('hidden', 'pending_review')).toBe(false);
  });

  it('giữ nguyên trạng thái luôn hợp lệ (no-op)', () => {
    expect(canTransitionBlogStatus('published', 'published')).toBe(true);
    expect(canTransitionBlogStatus('draft', 'draft')).toBe(true);
  });
});

describe('blog-state: suy audience', () => {
  it('bài chưa published/archived luôn private ở mọi space', () => {
    for (const space of ['course', 'school', 'user'] as const) {
      expect(deriveBlogAudience(space, 'draft')).toBe('private');
      expect(deriveBlogAudience(space, 'pending_review')).toBe('private');
      expect(deriveBlogAudience(space, 'hidden')).toBe('private');
      expect(deriveBlogAudience(space, 'deleted')).toBe('private');
    }
  });

  it('published: space khoá → course, trường/cá nhân → school', () => {
    expect(deriveBlogAudience('course', 'published')).toBe('course');
    expect(deriveBlogAudience('school', 'published')).toBe('school');
    expect(deriveBlogAudience('user', 'published')).toBe('school');
    expect(deriveBlogAudience('course', 'archived')).toBe('course');
  });
});

describe('blog-state: tương thích mô hình cũ', () => {
  it('chỉ published mới chiếu thành site', () => {
    expect(legacyPublishState('published')).toBe('site');
    expect(legacyPublishState('draft')).toBe('draft');
    expect(legacyPublishState('archived')).toBe('draft');
    expect(legacyPublishState('hidden')).toBe('draft');
  });

  it('site → published, còn lại → draft', () => {
    expect(statusFromLegacyPublishState('site')).toBe('published');
    expect(statusFromLegacyPublishState('draft')).toBe('draft');
    expect(statusFromLegacyPublishState('gì đó lạ')).toBe('draft');
  });
});
