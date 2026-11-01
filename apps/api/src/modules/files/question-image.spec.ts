import { describe, expect, it, vi } from 'vitest';
import {
  FilesService, QUESTION_IMAGE_MAX_BYTES, questionFileContentSrc, sniffImageMimeType,
} from './files.service';
import type { FileRow } from '@lms/db/repositories/files';

/** PNG 1x1 thật (byte đầy đủ) để kiểm tra đường vui. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP')]);
const GIF_HEAD = Buffer.from('GIF89a', 'ascii');
const TEXT_BYTES = Buffer.from('day khong phai la anh', 'utf8');

const CTX = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '11111111-1111-4111-8111-111111111111';

function makeService() {
  const rows = new Map<string, FileRow>();
  const repo = {
    insert: vi.fn(async (v: Record<string, unknown>) => {
      const row = { id: FILE_ID, createdAt: new Date(), ...v } as unknown as FileRow;
      rows.set(row.id, row);
      return row;
    }),
    getById: vi.fn(async (id: string) => rows.get(id)),
  };
  const storage = {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
    keyFor: (h: string) => h,
  };
  const evaluator = { requireCapability: vi.fn(async () => undefined) };
  const signing = {
    createDownloadTarget: vi.fn(async (file: FileRow) => ({
      url: `/api/v1/files/${file.id}/download?sig=stub`, expiresAt: Date.now() + 300_000,
    })),
  };
  const queue = { add: vi.fn(async () => undefined) };
  const service = new FilesService(
    repo as never, storage as never, evaluator as never, signing as never, queue as never,
  );
  return { service, repo, rows, signing };
}

describe('sniffImageMimeType — chỉ tin magic bytes', () => {
  it('nhận PNG/JPEG/WebP/GIF từ nội dung thật', () => {
    expect(sniffImageMimeType(PNG_1PX)).toBe('image/png');
    expect(sniffImageMimeType(JPEG_HEAD)).toBe('image/jpeg');
    expect(sniffImageMimeType(WEBP_HEAD)).toBe('image/webp');
    expect(sniffImageMimeType(GIF_HEAD)).toBe('image/gif');
  });

  it('từ chối nội dung không phải ảnh dù tên khai là ảnh', () => {
    expect(sniffImageMimeType(TEXT_BYTES)).toBeNull();
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('Hàm FilesService.uploadQuestionImage', () => {
  it('lưu ảnh hợp lệ với component question và mimetype do server sniff ra', async () => {
    const { service, repo } = makeService();
    const row = await service.uploadQuestionImage({
      contextId: CTX, fileArea: 'questiontext', fileName: 'so-do.png', data: PNG_1PX, userId: 'u1',
    });
    expect(row.component).toBe('question');
    expect(row.mimeType).toBe('image/png');
    expect(repo.insert).toHaveBeenCalledOnce();
    expect(questionFileContentSrc(row.id)).toBe(`/api/v1/files/${FILE_ID}/content`);
  });

  it('từ chối file chữ giả danh ảnh (400 file.not_image), không chạm kho', async () => {
    const { service, repo } = makeService();
    await expect(service.uploadQuestionImage({
      contextId: CTX, fileArea: 'questiontext', fileName: 'anh.png', data: TEXT_BYTES, userId: 'u1',
    })).rejects.toMatchObject({ response: { code: 'file.not_image' } });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('từ chối ảnh vượt trần 8 MB (400 file.image_too_large)', async () => {
    const { service } = makeService();
    const big = Buffer.alloc(QUESTION_IMAGE_MAX_BYTES + 1);
    PNG_1PX.copy(big, 0);
    await expect(service.uploadQuestionImage({
      contextId: CTX, fileArea: 'questiontext', fileName: 'lon.png', data: big, userId: 'u1',
    })).rejects.toMatchObject({ response: { code: 'file.image_too_large' } });
  });
});

describe('Hàm FilesService.resolveQuestionImageUrls', () => {
  const docWith = (src: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src, alt: 'hình' } }] }],
  });

  it('thay src định danh bền của file câu hỏi bằng URL ký, không sửa tài liệu gốc', async () => {
    const { service, rows } = makeService();
    rows.set(FILE_ID, { id: FILE_ID, component: 'question' } as FileRow);
    const doc = docWith(questionFileContentSrc(FILE_ID));
    const resolved = await service.resolveQuestionImageUrls(doc);
    const node = (resolved.content[0].content as { attrs: { src: string } }[])[0];
    expect(node.attrs.src).toBe(`/api/v1/files/${FILE_ID}/download?sig=stub`);
    const original = (doc.content[0].content as { attrs: { src: string } }[])[0];
    expect(original.attrs.src).toBe(questionFileContentSrc(FILE_ID));
  });

  it('giữ nguyên src khi file không thuộc component question (không rò file ngoài phạm vi câu hỏi)', async () => {
    const { service, rows, signing } = makeService();
    rows.set(FILE_ID, { id: FILE_ID, component: 'submission' } as FileRow);
    const doc = docWith(questionFileContentSrc(FILE_ID));
    const resolved = await service.resolveQuestionImageUrls(doc);
    const node = (resolved.content[0].content as { attrs: { src: string } }[])[0];
    expect(node.attrs.src).toBe(questionFileContentSrc(FILE_ID));
    expect(signing.createDownloadTarget).not.toHaveBeenCalled();
  });

  it('giữ nguyên src ngoài mẫu định danh (URL ngoài hệ) và file đã bị xoá', async () => {
    const { service } = makeService();
    const external = docWith('https://example.com/anh.png');
    await expect(service.resolveQuestionImageUrls(external)).resolves.toEqual(external);
    const missing = docWith(questionFileContentSrc(FILE_ID));
    await expect(service.resolveQuestionImageUrls(missing)).resolves.toEqual(missing);
  });
});
