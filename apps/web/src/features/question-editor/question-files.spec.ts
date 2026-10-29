import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '#lib/api';
import { QUESTION_IMAGE_MAX_BYTES, QuestionImageError } from './types/question-files';
import { questionFileIdFromSrc } from './utils/question-files';
import { uploadQuestionImage } from './api/question-files';

vi.mock('#lib/api', () => ({ apiFetch: vi.fn(), apiJson: vi.fn() }));

const CTX = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('questionFileIdFromSrc — định danh bền của ảnh câu hỏi', () => {
  it('trích được fileId từ src content chuẩn', () => {
    expect(questionFileIdFromSrc(`/api/v1/files/${FILE_ID}/content`)).toBe(FILE_ID);
  });

  it('trả null cho URL ngoài và cho URL ký (không phải định danh lưu trữ)', () => {
    expect(questionFileIdFromSrc('https://example.com/anh.png')).toBeNull();
    expect(questionFileIdFromSrc(`/api/v1/files/${FILE_ID}/download?sig=abc`)).toBeNull();
  });
});

describe('uploadQuestionImage — hợp đồng tải ảnh cho editor', () => {
  it('chặn sớm ảnh vượt trần 8 MB mà không gọi API', async () => {
    const big = new File([new Uint8Array(QUESTION_IMAGE_MAX_BYTES + 1)], 'lon.png', { type: 'image/png' });
    await expect(uploadQuestionImage(big, { contextId: CTX })).rejects.toMatchObject({ code: 'file.image_too_large' });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('chặn sớm tệp không phải ảnh', async () => {
    const txt = new File(['xin chao'], 'tailieu.txt', { type: 'text/plain' });
    await expect(uploadQuestionImage(txt, { contextId: CTX })).rejects.toMatchObject({ code: 'file.not_image' });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('gửi multipart đúng endpoint và trả src định danh bền + alt từ tên tệp', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(201, {
      id: FILE_ID, src: `/api/v1/files/${FILE_ID}/content`, fileName: 'so-do.png', mimeType: 'image/png',
    }));
    const file = new File(['png-bytes'], 'so-do.png', { type: 'image/png' });
    const result = await uploadQuestionImage(file, { contextId: CTX, fileArea: 'answer' });
    expect(result).toEqual({
      fileId: FILE_ID, src: `/api/v1/files/${FILE_ID}/content`, alt: 'so-do', fileName: 'so-do.png', mimeType: 'image/png',
    });
    const [path, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(path).toBe('/api/v1/files/question-image');
    const form = (init as RequestInit).body as FormData;
    expect(form.get('contextId')).toBe(CTX);
    expect(form.get('fileArea')).toBe('answer');
    expect(form.get('file')).toBeInstanceOf(File);
  });

  it('mang mã lỗi của server lên cho bề mặt chứa hiển thị (vd file.not_image khi byte không phải ảnh)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(400, { code: 'file.not_image', message: 'Only PNG...' }));
    const fake = new File(['khong phai anh'], 'anh.png', { type: 'image/png' });
    const err = await uploadQuestionImage(fake, { contextId: CTX }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuestionImageError);
    expect((err as QuestionImageError).code).toBe('file.not_image');
  });
});
