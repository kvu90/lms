import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';

/**
 * Endpoint hồ sơ người phục vụ panel chat 1–1 (issue #592):
 * trả định danh + tên hiển thị + tên đăng nhập + email từ dữ
 * kiện người dùng thật, chỉ khi người xem chung ít nhất một
 * conversation nhìn thấy được với đối tác. Các trường hồ sơ mở
 * rộng chưa có nguồn trong hệ (giới thiệu, điện thoại, website…)
 * KHÔNG có trong response này — chúng vẫn qua adapter ở web với
 * giá trị rỗng, tuyệt đối không bịa.
 *
 * Bốn ca: chung nhóm thì thấy hồ sơ thật; người lạ không chung
 * hội thoại nào thì 404; đối tác của hội thoại 1–1 đang chặn thì
 * 404 như không tồn tại; chính chủ xem hồ sơ của mình thì được.
 */
interface Person { id: string; username: string; email: string; token: string }

describe('Messaging — endpoint hồ sơ người cho panel chat (issue #592)', () => {
  let app: INestApplication;
  let viewer: Person;
  let partner: Person;
  let stranger: Person;
  let blockedPeer: Person;
  let blockedViewer: Person;

  async function person(firstName: string, lastName: string): Promise<Person> {
    const admin = await adminToken(app);
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, email: u.email, token: session.accessToken };
  }

  async function getProfile(token: string, userId: string) {
    return http(app).get(`/api/v1/messages/users/${userId}/profile`)
      .set('Authorization', `Bearer ${token}`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    const admin = await adminToken(app);
    viewer = await person('Bao', 'XemHoSo');
    partner = await person('Lan Anh', 'Nguyen');
    stranger = await person('Son', 'NguoiLa');
    blockedViewer = await person('Duc', 'ChanNguoi');
    blockedPeer = await person('Khanh', 'BiChan');

    // Người xem và đối tác chung một nhóm tự do (không cần kết
    // bạn — cổng chung hội thoại chấp nhận mọi loại conversation
    // nhìn thấy được).
    const group = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${admin}`).send({ memberIds: [viewer.id, partner.id], type: 2 });
    expect(group.status).toBe(201);

    // Cặp chặn: kết bạn hai chiều, mở 1–1, rồi phía xem chặn phía
    // kia — hội thoại 1–1 này không còn tính là chung nữa.
    const req = await http(app).post(`/api/v1/messages/contacts/${blockedViewer.id}`)
      .set('Authorization', `Bearer ${blockedPeer.token}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${blockedPeer.id}/accept`)
      .set('Authorization', `Bearer ${blockedViewer.token}`).send({});
    expect(acc.status).toBe(201);
    const dm = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${blockedPeer.token}`).send({ memberIds: [blockedViewer.id], type: 1 });
    expect(dm.status).toBe(201);
    const block = await http(app).post(`/api/v1/messages/contacts/${blockedPeer.id}/block`)
      .set('Authorization', `Bearer ${blockedViewer.token}`).send({});
    expect(block.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('đối tác chung nhóm thì trả đủ bốn trường thật từ bảng người dùng', async () => {
    const res = await getProfile(viewer.token, partner.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: partner.id,
      displayName: 'Lan Anh Nguyen',
      username: partner.username,
      email: partner.email,
    });
  });

  it('người lạ không chung hội thoại nào thì nhận 404 với mã hồ sơ không tìm thấy', async () => {
    const res = await getProfile(viewer.token, stranger.id);
    expect(res.status).toBe(404);
    expect((res.body as { code?: string }).code).toBe('messaging.person_profile_not_found');
  });

  it('đối tác của hội thoại 1–1 đang chặn thì nhận 404 như không tồn tại', async () => {
    const res = await getProfile(blockedViewer.token, blockedPeer.id);
    expect(res.status).toBe(404);
    expect((res.body as { code?: string }).code).toBe('messaging.person_profile_not_found');
  });

  it('chính chủ xem hồ sơ của mình luôn được phép', async () => {
    const res = await getProfile(viewer.token, viewer.id);
    expect(res.status).toBe(200);
    expect((res.body as { email?: string }).email).toBe(viewer.email);
  });
});
