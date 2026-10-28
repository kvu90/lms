import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTestApp, http, login, uniqueName } from '../support/identity-access-helpers';
import { createCategory, createClass, createCourse } from '../support/course-enrolment-helpers';

/**
 * Điều kiện cứng ở cửa sổ đóng gói CLASS-0 (PR #200, phán quyết độc lập
 * 6398586445 mục 4): khoá dạy thật PHẢI thuộc đúng một lớp. Spec này là
 * bản LẬT KỲ VỌNG của spec tái hiện của đội đánh giá
 * (review200-classless-course.e2e-spec.ts — ba ca từng tạo thành công
 * khoá không lớp ở head a9b4152): sau khi siết, mọi đường tạo khoá dạy
 * thật không lớp đều bị từ chối sạch 400 `course.class_required` ở tầng
 * service, và CHECK `course_class_required_check` gác ở tầng DB.
 *
 * Các đường được phủ:
 *  (1) POST /courses không kèm classId;
 *  (2) POST /courses kèm classId: null tường minh;
 *  (3) nhân bản khoá MẪU không lớp (class_id=null hợp lệ cho mẫu) mà
 *      không truyền lớp đích;
 *  (4) nhân bản kèm classId: null tường minh;
 *  (5) khôi phục backup mode=new (gọi createCourse không kèm lớp);
 *  (6) đối chứng dương: nhân bản khoá mẫu không lớp CÓ truyền lớp đích
 *      thì thành công và bản sao nằm trong lớp đích;
 *  (7) đối chứng dương: POST /courses có classId thì thành công;
 *  (8) lưới DB: INSERT thẳng khoá dạy thật không lớp bị CHECK chặn
 *      (23514), trong khi khoá mẫu không lớp vẫn hợp lệ.
 */
describe('Course must belong to a class (#200 packaging, #184)', () => {
  let app: INestApplication;
  let admin = '';
  let categoryId = '';
  let classId = '';
  let pool: Pool;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Dựng một khoá mẫu KHÔNG lớp: tạo trong lớp rồi đánh dấu mẫu, sau đó
   * gỡ class_id bằng SQL (trạng thái hợp lệ duy nhất cho mẫu theo CHECK). */
  async function makeClasslessTemplate(): Promise<string> {
    const created = await createCourse(app, admin, categoryId, { classId });
    const patched = await http(app).patch(`/api/v1/courses/${created.id}`).set(auth(admin)).send({ isTemplate: true });
    expect(patched.status).toBe(200);
    await pool.query('update course set class_id = null where id = $1', [created.id]);
    return created.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    admin = (await login(app, 'admin', 'Admin123!')).accessToken;
    categoryId = (await createCategory(app, admin)).id;
    classId = (await createClass(app, admin)).id;
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('(1) POST /courses KHÔNG kèm classId → 400 course.class_required', async () => {
    const shortName = uniqueName('nocls');
    const res = await http(app).post('/api/v1/courses').set(auth(admin))
      .send({ fullName: `Course ${shortName}`, shortName, category: categoryId });
    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('course.class_required');
  });

  it('(2) POST /courses kèm classId: null tường minh → 400 course.class_required', async () => {
    const shortName = uniqueName('nullcls');
    const res = await http(app).post('/api/v1/courses').set(auth(admin))
      .send({ fullName: `Course ${shortName}`, shortName, category: categoryId, classId: null });
    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('course.class_required');
  });

  it('(3) nhân bản khoá MẪU không lớp, không truyền lớp đích → 400', async () => {
    const tplId = await makeClasslessTemplate();
    const copyName = uniqueName('copy');
    const dup = await http(app).post(`/api/v1/courses/${tplId}/copy`).set(auth(admin))
      .send({ fullName: `Copy ${copyName}`, shortName: copyName });
    expect(dup.status).toBe(400);
    expect((dup.body as { code?: string }).code).toBe('course.class_required');
  });

  it('(4) nhân bản kèm classId: null tường minh → 400', async () => {
    const src = await createCourse(app, admin, categoryId, { classId });
    const copyName = uniqueName('copy4');
    const dup = await http(app).post(`/api/v1/courses/${src.id}/copy`).set(auth(admin))
      .send({ fullName: `Copy ${copyName}`, shortName: copyName, classId: null });
    expect(dup.status).toBe(400);
    expect((dup.body as { code?: string }).code).toBe('course.class_required');
  });

  it('(5) khôi phục backup mode=new (tạo khoá mới không lớp) → 400 course.class_required', async () => {
    const src = await createCourse(app, admin, categoryId, { classId });
    const backup = await http(app).post('/api/v1/backup/jobs').set(auth(admin)).send({ courseId: src.id });
    expect(backup.status).toBeLessThan(300);
    expect((backup.body as { status: string }).status).toBe('completed');
    const restore = await http(app).post('/api/v1/backup/restore').set(auth(admin))
      .send({ backupJobId: (backup.body as { id: string }).id, mode: 'new' });
    expect(restore.status).toBe(400);
    expect((restore.body as { code?: string }).code).toBe('course.class_required');
  });

  it('(6) đối chứng dương: nhân bản khoá mẫu không lớp CÓ lớp đích → 201, bản sao thuộc lớp đích', async () => {
    const tplId = await makeClasslessTemplate();
    const copyName = uniqueName('copy6');
    const dup = await http(app).post(`/api/v1/courses/${tplId}/copy`).set(auth(admin))
      .send({ fullName: `Copy ${copyName}`, shortName: copyName, classId });
    expect(dup.status).toBe(201);
    const body = dup.body as { classId: string | null; isTemplate: boolean };
    expect(body.classId).toBe(classId);
    expect(body.isTemplate).toBe(false);
  });

  it('(7) đối chứng dương: POST /courses có classId → 201', async () => {
    const created = await createCourse(app, admin, categoryId, { classId });
    expect(created.id).toBeTruthy();
  });

  it('(8) lưới DB: INSERT khoá dạy thật không lớp bị CHECK chặn; khoá mẫu không lớp hợp lệ', async () => {
    const shortName = uniqueName('raw');
    await expect(pool.query(
      'insert into course (category, tenant_id, full_name, short_name) values ($1, (select tenant_id from course_categories where id = $1), $2, $3)',
      [categoryId, `Raw ${shortName}`, shortName],
    )).rejects.toMatchObject({ code: '23514' });
    const tpl = await pool.query(
      'insert into course (category, tenant_id, full_name, short_name, is_template) values ($1, (select tenant_id from course_categories where id = $1), $2, $3, true) returning id',
      [categoryId, `RawTpl ${shortName}`, `${shortName}t`],
    );
    expect(tpl.rows[0].id).toBeTruthy();
  });
});
