import { describe, expect, it } from 'vitest';
import { blankRecalledContent, type MessageRow } from './messaging.repository';
import { isWithinRecallWindow } from './messaging.service';

/**
 * Kiểm chứng đơn vị cho hai luật thuần của vòng đời tin nhắn theo
 * vai (issue #33): biên cửa sổ THU HỒI và vô hiệu nội dung khi trình
 * bày một tin đã thu hồi. Phần nghiệp vụ đầy đủ (quyền theo vai, dấu
 * vết moderator_action, realtime) nằm ở spec e2e
 * messaging-message-lifecycle.
 */
describe('isWithinRecallWindow (cửa sổ thu hồi)', () => {
  const sentAt = new Date('2026-10-25T00:00:00.000Z');

  it('tin vừa gửi nằm trong cửa sổ mặc định 15 phút', () => {
    expect(isWithinRecallWindow(sentAt, new Date(sentAt.getTime() + 1_000), 15)).toBe(true);
  });

  it('đúng biên 15 phút vẫn được tính là trong cửa sổ', () => {
    expect(isWithinRecallWindow(sentAt, new Date(sentAt.getTime() + 15 * 60_000), 15)).toBe(true);
  });

  it('quá biên một mili-giây là ngoài cửa sổ', () => {
    expect(isWithinRecallWindow(sentAt, new Date(sentAt.getTime() + 15 * 60_000 + 1), 15)).toBe(false);
  });

  it('cửa sổ 0 nghĩa là thu hồi đã TẮT — kể cả tin vừa gửi', () => {
    expect(isWithinRecallWindow(sentAt, sentAt, 0)).toBe(false);
  });

  it('cửa sổ âm cũng là tắt', () => {
    expect(isWithinRecallWindow(sentAt, sentAt, -5)).toBe(false);
  });

  it('cửa sổ cấu hình rộng hơn nới đúng theo giá trị đó', () => {
    expect(isWithinRecallWindow(sentAt, new Date(sentAt.getTime() + 59 * 60_000), 60)).toBe(true);
    expect(isWithinRecallWindow(sentAt, new Date(sentAt.getTime() + 61 * 60_000), 60)).toBe(false);
  });
});

describe('blankRecalledContent (vô hiệu nội dung tin đã thu hồi)', () => {
  const baseRow = {
    id: '123e4567-e89b-72d3-a456-426614174000',
    conversationId: '123e4567-e89b-72d3-a456-426614174001',
    userIdFrom: '123e4567-e89b-72d3-a456-426614174002',
    subject: '',
    fullMessage: 'nội dung gốc',
    smallMessage: 'nội dung gốc',
    timeCreated: 0,
    component: 'core_message',
    eventType: 'message',
    contextUrl: null,
    contextUrlName: null,
    clientMessageId: null,
    seq: 7,
    deletedAt: null,
    deletedBy: null,
    recalledAt: null,
    recalledBy: null,
    createdAt: new Date('2026-10-25T00:00:00.000Z'),
  } as unknown as MessageRow;

  it('tin chưa thu hồi được giữ nguyên (cùng tham chiếu)', () => {
    expect(blankRecalledContent(baseRow)).toBe(baseRow);
  });

  it('tin đã thu hồi: nội dung rỗng, định danh và dấu thu hồi giữ nguyên', () => {
    const recalledAt = new Date('2026-10-25T00:05:00.000Z');
    const row = { ...baseRow, recalledAt, recalledBy: baseRow.userIdFrom } as MessageRow;
    const blanked = blankRecalledContent(row);
    expect(blanked.fullMessage).toBe('');
    expect(blanked.smallMessage).toBe('');
    expect(blanked.id).toBe(row.id);
    expect(blanked.seq).toBe(7);
    expect(blanked.recalledAt).toBe(recalledAt);
    expect(blanked.recalledBy).toBe(baseRow.userIdFrom);
    // Dòng gốc trong DB không bị sửa tại chỗ.
    expect(row.fullMessage).toBe('nội dung gốc');
  });
});
