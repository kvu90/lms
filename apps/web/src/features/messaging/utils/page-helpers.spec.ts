import { beforeEach, describe, expect, it } from 'vitest';
import { readStoredMessagesTab, storeMessagesTab } from './page-helpers';

/** Khoá localStorage của tab khung trái Tin nhắn — đúng khoá page-helpers đang dùng. */
const TAB_KEY = 'lms.messages.tab';

/**
 * Lưu bền tab khung trái của trang Tin nhắn (issue #606): thanh
 * tab hiện hành có bốn giá trị hợp lệ; giá trị đã lưu theo các
 * cấu trúc tab cũ phải rơi về tab Tất cả mặc định thay vì làm
 * khung trái mở vào một tab không còn tồn tại.
 */
describe('Lưu bền tab khung trái Tin nhắn', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('về tab Tất cả khi chưa từng lưu tab nào', () => {
    expect(readStoredMessagesTab()).toBe('all');
  });

  it('giữ nguyên từng giá trị hợp lệ của thanh tab hiện hành: all, unread, groups, favourites', () => {
    for (const tab of ['all', 'unread', 'groups', 'favourites']) {
      window.localStorage.setItem(TAB_KEY, tab);
      expect(readStoredMessagesTab()).toBe(tab);
    }
  });

  it('giá trị lưu cũ "chats" của cấu trúc hai tab rơi về tab Tất cả', () => {
    window.localStorage.setItem(TAB_KEY, 'chats');
    expect(readStoredMessagesTab()).toBe('all');
  });

  it('giá trị lưu cũ "archived" của cấu trúc có tab Đã lưu trữ rơi về tab Tất cả', () => {
    window.localStorage.setItem(TAB_KEY, 'archived');
    expect(readStoredMessagesTab()).toBe('all');
  });

  it('giá trị lạ không thuộc tập tab nào cũng rơi về tab Tất cả', () => {
    window.localStorage.setItem(TAB_KEY, 'khong-ton-tai');
    expect(readStoredMessagesTab()).toBe('all');
  });

  it('ghi tab bằng storeMessagesTab thì đọc lại đúng tab đó', () => {
    storeMessagesTab('groups');
    expect(window.localStorage.getItem(TAB_KEY)).toBe('groups');
    expect(readStoredMessagesTab()).toBe('groups');
  });
});
