import type { INestApplication } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FilesService } from '../../../src/modules/files/files.service';
import {
  adminToken, assignRole, createContextViaApi, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from '../../support/identity-access-helpers';

/**
 * Bất biến tầng lưu trữ của Files — nửa khẳng định nội bộ tách từ
 * `test/e2e/files/files-flow.e2e-spec.ts` (issue #483).
 *
 * File e2e gốc trộn hai bề mặt trong cùng một ca: bề mặt HTTP (tải
 * lên, xoá bản ghi, `refcount` trong body phản hồi) và bất biến của
 * tầng lưu trữ chỉ đọc được qua `FilesService` — `refcount` đếm ở
 * kho, sự tồn tại của file vật lý tại khoá nội dung
 * (`physicalKey`), và hành vi dọn file mồ côi `cleanupOrphan` của
 * đường worker. Các bất biến này không có bề mặt HTTP tương đương
 * nên thuộc tầng integration theo quy ước của dự án; nửa HTTP ở lại
 * file e2e. Fixture (context, người tải lên, nội dung tải lên) dựng
 * qua HTTP như file gốc — đó là bước chuẩn bị, tầng của test do
 * act/assert quyết định.
 *
 * Nội dung của từng ca là duy nhất theo thời điểm chạy để kho lưu
 * trữ dùng chung của suite không lẫn với các spec khác.
 */
describe('Files: bất biến lưu trữ theo nội dung (integration)', () => {
  let app: INestApplication;
  let admin: string;
  let courseCtx: string;
  let uploaderToken: string;

  async function upload(token: string, fileName: string, content: string): Promise<{ id: string; contentHash: string }> {
    const res = await http(app).post('/api/v1/files').set('Authorization', `Bearer ${token}`)
      .field('contextId', String(courseCtx)).field('component', 'core_user').field('fileArea', 'profile')
      .attach('file', Buffer.from(content), fileName);
    if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const systemId = await systemContextId(app, admin);
    courseCtx = (await createContextViaApi(app, admin, 50, uuidv7(), systemId)).id;
    const uploader = await createUserViaApi(app, admin);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    await assignRole(app, admin, uploader.id, studentRole, courseCtx);
    uploaderToken = (await login(app, uploader.username, STRONG_PASSWORD)).accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('hai bản ghi cùng nội dung: refcount bằng 2 và đúng một file vật lý tại khoá nội dung', async () => {
    const content = `storage-invariant-dedup-${Date.now()}`;
    const a = await upload(uploaderToken, 'a.txt', content);
    const b = await upload(uploaderToken, 'b.txt', content);
    expect(a.contentHash).toBe(b.contentHash);
    const service = app.get(FilesService);
    expect(await service.refcount(a.contentHash)).toBe(2);
    expect(existsSync(service.physicalKey(a.contentHash))).toBe(true);
    expect(service.physicalKey(a.contentHash)).toContain(`/${a.contentHash.slice(0, 2)}/${a.contentHash.slice(2, 4)}/`);
  });

  it('xoá hết bản ghi: file vật lý còn khi còn một bản ghi, cleanupOrphan gỡ file khi refcount về 0', async () => {
    const content = `storage-invariant-orphan-${Date.now()}`;
    const a = await upload(uploaderToken, 'c.txt', content);
    const b = await upload(uploaderToken, 'd.txt', content);
    const service = app.get(FilesService);
    const delA = await http(app).delete(`/api/v1/files/${a.id}`).set('Authorization', `Bearer ${uploaderToken}`);
    expect(delA.status).toBe(200);
    expect(existsSync(service.physicalKey(a.contentHash))).toBe(true);
    const delB = await http(app).delete(`/api/v1/files/${b.id}`).set('Authorization', `Bearer ${uploaderToken}`);
    expect(delB.status).toBe(200);
    // Bộ xử lý của worker chạy cùng thao tác facade mà API đã đưa vào hàng đợi.
    const removed = await service.cleanupOrphan(a.contentHash);
    expect(removed).toBe(true);
    expect(existsSync(service.physicalKey(a.contentHash))).toBe(false);
  });
});
