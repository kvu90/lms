import { INestApplication } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { FilesService } from '../../../src/modules/files/files.service';
import {
  adminToken, assignRole, createContextViaApi, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from '../../support/identity-access-helpers';

/**
 * Kiểm thử luồng File (trường hợp file chuẩn vàng của báo cáo §3.11).
 * Oracle: public/lib/filestorage/tests/file_storage_test.php (MOODLE_503_STABLE) —
 * test_create_file_from_string, test_get_file_by_hash, test_delete_area_files;
 * ngữ nghĩa dedup/refcount từ tài liệu nội bộ File API (báo cáo §3.8).
 * Lưu ý: contentHash của chúng ta là SHA-256 (quyết định của dự án, không tương thích cũ) trong khi Moodle dùng SHA-1.
 */
describe('Files: content-addressed dedup, refcount cleanup, capability-checked serving', () => {
  let app: INestApplication;
  let admin: string;
  let courseCtx: string;
  let uploaderToken: string;
  let uploaderId: string;
  const CONTENT = `hello-dedup-content-${Date.now()}`;

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
    uploaderId = uploader.id;
    const studentRole = await roleIdByShortname(app, admin, 'student');
    await assignRole(app, admin, uploader.id, studentRole, courseCtx);
    uploaderToken = (await login(app, uploader.username, STRONG_PASSWORD)).accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('uploading identical content twice stores ONE physical file behind TWO records', async () => {
    const a = await upload(uploaderToken, 'a.txt', CONTENT);
    const b = await upload(uploaderToken, 'b.txt', CONTENT);
    expect(a.id).not.toBe(b.id);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toHaveLength(64); // SHA-256 dạng hex
    const service = app.get(FilesService);
    expect(await service.refcount(a.contentHash)).toBe(2);
    expect(existsSync(service.physicalKey(a.contentHash))).toBe(true);
    expect(service.physicalKey(a.contentHash)).toContain(`/${a.contentHash.slice(0, 2)}/${a.contentHash.slice(2, 4)}/`);
  });

  it('deleting one record keeps the physical file; deleting the last queues cleanup and the worker path removes it', async () => {
    const a = await upload(uploaderToken, 'c.txt', `${CONTENT}-v2`);
    const b = await upload(uploaderToken, 'd.txt', `${CONTENT}-v2`);
    const service = app.get(FilesService);
    const delA = await http(app).delete(`/api/v1/files/${a.id}`).set('Authorization', `Bearer ${uploaderToken}`);
    expect(delA.status).toBe(200);
    expect(delA.body.refcount).toBe(1);
    expect(existsSync(service.physicalKey(a.contentHash))).toBe(true);
    const delB = await http(app).delete(`/api/v1/files/${b.id}`).set('Authorization', `Bearer ${uploaderToken}`);
    expect(delB.body.refcount).toBe(0);
    // Bộ xử lý của worker chạy cùng thao tác facade mà API đã đưa vào hàng đợi.
    const removed = await service.cleanupOrphan(a.contentHash);
    expect(removed).toBe(true);
    expect(existsSync(service.physicalKey(a.contentHash))).toBe(false);
  });

  it('serves content to a user with the file-context capability via signed URL and guarded stream', async () => {
    const file = await upload(uploaderToken, 'serve.txt', 'serve-me');
    const signed = await http(app).post(`/api/v1/files/${file.id}/signed-url`).set('Authorization', `Bearer ${uploaderToken}`);
    expect(signed.status).toBe(201);
    const download = await http(app).get(signed.body.url.replace('/api/v1', '/api/v1'));
    expect(download.status).toBe(200);
    expect(download.text).toBe('serve-me');
    const stream = await http(app).get(`/api/v1/files/${file.id}/content`).set('Authorization', `Bearer ${uploaderToken}`);
    expect(stream.status).toBe(200);
    expect(stream.text).toBe('serve-me');
  });

  it('denies a stranger: signed-url request and guarded stream return 403 Problem Details; unsigned download is 401', async () => {
    const file = await upload(uploaderToken, 'secret.txt', 'top-secret');
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const signed = await http(app).post(`/api/v1/files/${file.id}/signed-url`).set('Authorization', `Bearer ${strangerToken}`);
    expect(signed.status).toBe(403);
    expect(signed.headers['content-type']).toContain('application/problem+json');
    expect(signed.body.code).toBe('access.capability_denied');
    const stream = await http(app).get(`/api/v1/files/${file.id}/content`).set('Authorization', `Bearer ${strangerToken}`);
    expect(stream.status).toBe(403);
    const unsigned = await http(app).get(`/api/v1/files/${file.id}/download`);
    expect(unsigned.status).toBe(401);
    const tampered = await http(app).get(`/api/v1/files/${file.id}/download`).query({ sig: '9999999999.forged' });
    expect(tampered.status).toBe(401);
    void uploaderId;
  });
});
