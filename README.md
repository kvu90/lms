# LMS — TypeScript (NestJS + React)

A from-scratch TypeScript LMS whose business scope is equivalent to Moodle's
core subsystems (backend only; no backward compatibility with Moodle's DB,
file formats or protocols — see the research report).

## Layout

```
apps/
  api/      NestJS 12 REST API (TypeScript 6), Drizzle ORM, BullMQ, Redis cache
  worker/   NestJS 12 background process: BullMQ processors, outbox relay, scheduled jobs
  web/      React + Vite + React Router SPA (TypeScript 7), shadcn/ui + Tailwind
packages/
  contracts/  Shared zod schemas (Problem Details, health, …) — the only api↔web contract
  config/     Shared tsconfig bases
```

Dependency rule: `web` depends only on `contracts`; `api`/`worker` share the
database and Redis but own separate processes. The frontend never imports
backend code or DB schema.

## Prerequisites

- Node 24 (`.nvmrc`), pnpm 12.14
- PostgreSQL 18.6 at `localhost:5432` (user `postgres`/`postgres`, DBs `lms` and `lms_test`) — 18.x is required: primary keys default to the native `uuidv7()` function
- Redis at `localhost:6379`

## Run

```bash
pnpm install
cp apps/api/.env.example apps/api/.env       # defaults already match local infra
pnpm --filter @lms/api db:migrate            # create the infrastructure tables
pnpm --filter @lms/api build && pnpm --filter @lms/api start   # API on :3000
pnpm --filter @lms/worker build && pnpm --filter @lms/worker start
pnpm --filter @lms/web dev                   # web on :5173 (proxies /api → :3000)
```

- Health: `GET http://localhost:3000/api/v1/health`
- OpenAPI: `http://localhost:3000/api/docs`

## Review

### Deployed review instance (primary)

The full stack runs on Heroku as app `kvu-lms` (buildpack deployment):

- App: https://kvu-lms-573c864b6f10.herokuapp.com/ (login at `/login`)
- Health: `GET https://kvu-lms-573c864b6f10.herokuapp.com/api/v1/health`
- The Heroku-assigned hostname above is the real one — the plain
  `kvu-lms.herokuapp.com` name was not issued and returns "No such app".
- Eco dynos sleep after 30 minutes idle, so the first request may take
  a few seconds to wake the app.
- Known issue: the Key-Value Store (Redis) mini data plane currently
  refuses TLS handshakes from the app dynos, so health reports
  `redis: down` while `database: up`. Login, course data and the UI
  work; cache/queue-backed features are degraded.

Use the demo accounts in the table below to sign in.

### Local review environment (fallback)

Everything below is for the local **development/review environment only** —
the passwords are sample credentials for the seeded demo accounts, never
for production.

### Start the full stack (in order)

```bash
# 1) Infrastructure (this machine)
sudo pg_ctlcluster 18 main start          # PostgreSQL 18.6 on localhost:5432 (or: sudo service postgresql start)
redis-server --daemonize yes              # Redis on localhost:6379 (or: sudo service redis-server start)

# 2) Install + schema + sample data (first run only; the seed is idempotent)
pnpm install
cp apps/api/.env.example apps/api/.env    # defaults match the local infra (skip if .env exists)
pnpm --filter @lms/api db:migrate
pnpm seed                                 # builds the API, then seeds the demo data below

# 3) Run everything (API :3000, worker, web :5173) with one command
pnpm dev
```

- Login page: `http://localhost:5173/login`
- API health: `http://localhost:3000/api/v1/health` · OpenAPI: `http://localhost:3000/api/docs`

### Demo accounts (seeded by `pnpm seed`)

| Role | Username | Password |
|------|----------|----------|
| Site admin | `admin` | `Admin123!` |
| Teacher (editing teacher of the demo course) | `teacher1` | `Teacher123!` |
| Student | `student1` | `Student123!` |
| Student | `student2` | `Student123!` |

The admin account is created by the API bootstrap itself from
`ADMIN_USERNAME` / `ADMIN_PASSWORD` (defaults above; override via
`apps/api/.env`). The seed adds: the course **DEMO101 — "Khoá học mẫu: Làm
quen với LMS"** with 3 sections and 3 modules, both students enrolled,
sample grades (student1 = 8.5, student2 = 6.5 on "Bài kiểm tra 1"), the
badge "Huy hiệu khởi đầu" already awarded to student1, and a course
calendar event for tomorrow 09:00.

The seed also loads the **full GDPT 2018 national programme**: all 21
đã kiểm chứng được vendor sẵn trong repo (2.115 bản ghi trên 19 môn
có dữ liệu — môn thứ 20, GDQP&AN, chưa có dataset đã kiểm chứng —
đối chiếu nguyên văn với tài liệu của Bộ). Seed **không** nạp từng
dataset theo từng bản ghi: nó restore bản dump chương trình đông
cứng đóng gói sẵn trong repo
(`apps/api/src/modules/curriculum/program-data-dump/program-dump.sql`,
được `ProgramDumpService` tạo một lần từ cơ sở dữ liệu chuẩn đã
kiểm chứng), nên một cơ sở dữ liệu dựng từ baseline + `pnpm seed`
đã chứa trọn cây chương trình với đúng cùng một tập định danh bản
ghi ở mọi môi trường — **sau khi reset không cần bước "import" thủ
công nào trong giao diện quản trị** (trang quản trị chỉ giữ đồng bộ
lại qua `ProgramImportService` như một tiện ích khi đính chính
dataset). Chạy lại seed sẽ bỏ qua phần chương trình khi dữ liệu đã
có mặt (restore theo cơ chế restore-if-empty), nên định danh chương
trình không bao giờ thay đổi khi seed lại. Đính chính một dataset
nghĩa là sửa ở cơ sở dữ liệu chuẩn rồi xuất lại dump
(`apps/api/src/export-program-dump.ts`), tuyệt đối không sửa tay
file dump.

### Main flows to review

Log in → open the demo course → gradebook (teacher sees the class report)
→ question bank → messages & notifications → calendar → badges → learning
plans → search → backup / privacy (platform pages, admin).

### Language

The UI defaults to **Vietnamese**. Switch to English with the
"Ngôn ngữ / Language" selector in the top bar; the API likewise answers in
Vietnamese by default and honours `Accept-Language: en`.

## Verify (definition of green)

```bash
pnpm install
turbo run build typecheck test
```

## Operations

HTTP edge protection: standard security headers on every
response, CORS restricted to `CORS_ORIGINS`, and two-layer per-IP rate
limiting via the official `@nestjs/throttler` — a global
`RATE_LIMIT_PER_MINUTE` plus a stricter `RATE_LIMIT_AUTH_PER_MINUTE`
for credential-checking auth routes. Tune them with care before
tightening: schools behind NAT share one public IP.

## Version policy

Always the latest release of every dependency, except where a documented
blocker forces a pin (recorded below). Current pins/blocks:

- NestJS apps (`api`, `worker`): TypeScript **6.0.3** — `nest build`/Nest
  toolchain does not support TypeScript 7 yet. Everything else: 7.0.2.
- Drizzle: `drizzle-orm@rc` / `drizzle-kit@rc` (1.0.0-rc.5) via the official
  `@nestjs/drizzle` integration, exactly as in the official NestJS Drizzle
  chapter.
- Test runner: Vitest everywhere — no Jest.

## Known simplifications

- The worker keeps a subset view of the shared DB schema in
  `apps/worker/src/db/schema.ts` (only the tables its processors touch,
  with only the columns they use); the canonical schema lives in the API,
  split per bounded context (see Conventions).
- The API `dev` script is `tsc --watch` + `node --watch` rather than the Nest
  CLI, keeping the build identical to CI (`tsc`).

## Conventions (official)

- **I18n is mandatory and centralized**: no hardcoded display
  strings. Backend/worker use the official **@nestjs/i18n** (pinned exact
  `0.0.1`) with JSON catalogs in `src/i18n/<locale>/` — default locale
  **Vietnamese**, English alongside; errors carry stable English `code`s and
  their display text is looked up by code. Frontend uses i18next +
  react-i18next with centralized resources (`apps/web/src/i18n.ts`).
- **Validation is Zod-only**: base schemas live in
  `packages/contracts` and are the single source of truth for the API
  (Standard Schema pipe) and React forms; server-only fields extend the
  base schema. class-validator/class-transformer are removed from the repo entirely.
- **Language of code and comments**: identifiers, API docs, log keys and
  error codes in English; **comments in Vietnamese in TSDoc style**
  (`/** */` with `@param`/`@returns`/`@throws` where fitting) for every
  public API and for non-obvious business logic.
- **Database schema is split by bounded context**: each module
  owns its Drizzle tables in `apps/api/src/modules/<module>/schema.ts`;
  platform-infrastructure tables live in `apps/api/src/db/infrastructure.schema.ts`;
  `apps/api/src/db/schema.ts` is only a barrel re-exporting everything for
  `drizzle.config.ts` and the Drizzle module. Table/column names never
  change when a schema file moves.
- **Naming & repo hygiene**: everything is named after the
  business / bounded context — **no phase labels** in code, comments, test
  names or commit subjects; **never commit compiled output** (`dist/`,
  stray `.js`/`.d.ts` next to sources). This is a writing discipline,
  upheld by authoring code correctly in the first place and by review —
  there is deliberately no automated enforcement for it.
- **Feature acceptance**: a feature is done only when its
  backend business flow is covered by a flow test translated from the
  Moodle PHPUnit oracle.
- **Versions are latest-first**: always the newest release;
  pin or downgrade only for a documented blocker recorded above
  (current blocker: TypeScript 6 for the NestJS apps).
