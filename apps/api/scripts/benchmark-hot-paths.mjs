#!/usr/bin/env node
/**
 * Đo độ trễ các đường nóng của API trên một khoá học lớn nhân tạo
 * (mặc định 60 học viên × 3 đầu điểm): kiểm tra capability khi xem nội
 * dung khoá học, sổ điểm của giáo viên, hồ sơ người dùng và danh sách
 * khoá học. Chạy chống lại một API đang chạy (môi trường dev/review):
 *
 *   BENCH_BASE_URL=http://localhost:3000 node scripts/benchmark-hot-paths.mjs
 *
 * Dữ liệu bench được tạo bằng tiền tố `bench` để dễ dọn. Kết quả là số
 * đo tham chiếu trên máy chạy — không phải cam kết hiệu năng; ghi lại
 * mốc đo vào docs/operations-runbook.md mỗi đợt đo chuẩn.
 */
const BASE = process.env.BENCH_BASE_URL ?? 'http://localhost:3000';
const ADMIN = { username: process.env.BENCH_ADMIN_USERNAME ?? 'admin', password: process.env.BENCH_ADMIN_PASSWORD ?? 'Admin123!' };
const STUDENTS = Number(process.env.BENCH_STUDENTS ?? 60);
const ITEMS = 3;
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 30);
const PASSWORD = 'Bench123!';
const run = `bench${Date.now().toString(36)}`;

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function login(username, password) {
  const res = await api(null, 'POST', '/api/v1/auth/token', { username, password });
  return res.accessToken;
}

function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { n: sorted.length, p50: pick(50), p95: pick(95), max: sorted[sorted.length - 1] };
}

async function measure(label, fn) {
  const samples = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(Math.round(performance.now() - t0));
  }
  const s = stats(samples);
  console.log(`${label.padEnd(46)} n=${s.n}  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms`);
  return s;
}

const admin = await login(ADMIN.username, ADMIN.password);
console.log(`setup: category + course + ${STUDENTS} students + ${ITEMS} grade items (run=${run})`);
const cat = await api(admin, 'POST', '/api/v1/courses/categories', { name: `${run} category` });
const course = await api(admin, 'POST', '/api/v1/courses', { category: cat.id, fullname: `${run} course`, shortname: `${run}c` });
const instance = await api(admin, 'POST', `/api/v1/courses/${course.id}/enrol/instances`, { method: 'manual' });

const teacher = await api(admin, 'POST', '/api/v1/users', {
  username: `${run}-teacher`, email: `${run}-teacher@example.com`, password: PASSWORD, firstname: 'Bench', lastname: 'Teacher',
});
const contexts = await api(admin, 'GET', '/api/v1/access/contexts');
const courseCtx = contexts.find((c) => c.contextlevel === 50 && c.instanceid === course.id);
const roles = await api(admin, 'GET', '/api/v1/access/roles');
const teacherRole = roles.find((r) => r.shortname === 'editingteacher');
await api(admin, 'POST', '/api/v1/access/assignments', { userid: teacher.id, roleid: teacherRole.id, contextid: courseCtx.id });

const studentIds = [];
for (let i = 0; i < STUDENTS; i += 1) {
  const u = await api(admin, 'POST', '/api/v1/users', {
    username: `${run}-s${i}`, email: `${run}-s${i}@example.com`, password: PASSWORD, firstname: 'Bench', lastname: `Student${i}`,
  });
  await api(admin, 'POST', `/api/v1/courses/${course.id}/enrol/instances/${instance.id}/enrol`, { userid: u.id });
  studentIds.push(u.id);
}
const items = [];
for (let i = 0; i < ITEMS; i += 1) {
  items.push(await api(admin, 'POST', `/api/v1/courses/${course.id}/grades/items`, { itemname: `Bench item ${i}`, grademax: 10 }));
}
for (const item of items) {
  for (const sid of studentIds) {
    await api(admin, 'POST', `/api/v1/courses/grades/items/${item.id}/grades`, { userid: sid, rawgrade: 7 });
  }
}
const teacherToken = await login(teacher.username, PASSWORD);
const studentToken = await login(`${run}-s0`, PASSWORD);

console.log(`measure: ${ROUNDS} sequential requests per path`);
await measure('GET /users/me (student)', () => api(studentToken, 'GET', '/api/v1/users/me'));
await measure('GET /courses/:id/content (student, capability)', () => api(studentToken, 'GET', `/api/v1/courses/${course.id}/content`));
await measure(`GET /courses/:id/gradebook (teacher, ${STUDENTS} students)`, () => api(teacherToken, 'GET', `/api/v1/courses/${course.id}/gradebook`));
await measure('GET /courses (admin list)', () => api(admin, 'GET', '/api/v1/courses'));
console.log('done. Bench data is prefixed with', run, '— delete via SQL/API when finished.');
