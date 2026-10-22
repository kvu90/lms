# LMS — TypeScript (NestJS + React)

A from-scratch TypeScript LMS whose business scope is equivalent to Moodle's
core subsystems (backend only; no backward compatibility with Moodle's DB,
file formats or protocols — see the research report and `docs/adr/`).

## Layout

```
apps/
  api/      NestJS 12 REST API (TypeScript 6 — ADR-003), Drizzle ORM, BullMQ, Redis cache
  worker/   NestJS 12 background process: BullMQ processors, outbox relay, scheduled jobs
  web/      React + Vite + React Router SPA (TypeScript 7), shadcn/ui + Tailwind
packages/
  contracts/  Shared zod schemas (Problem Details, health, …) — the only api↔web contract
  config/     Shared tsconfig bases + ESLint flat config
docs/
  adr/                Architecture decision records
  business-traceability.md  Moodle test-suite → our-test mapping (per phase)
```

Dependency rule: `web` depends only on `contracts`; `api`/`worker` share the
database and Redis but own separate processes. The frontend never imports
backend code or DB schema.

## Prerequisites

- Node 24 (`.nvmrc`), pnpm 12.14
- PostgreSQL 18.6 at `localhost:5432` (user `postgres`/`postgres`, DBs `lms` and `lms_test`) — 18.x is required: primary keys default to the native `uuidv7()` function (ADR-013)
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
turbo run build typecheck lint test
```

## Operations

See `docs/operations-runbook.md` for the operator runbook: JWT secret
rotation, outbox replay, orphan file cleanup, audit-trail queries,
backup/restore, PostgreSQL upgrades, and the hot-path performance
baseline (`apps/api/scripts/benchmark-hot-paths.mjs`).

HTTP edge protection (ADR-014): standard security headers on every
response, CORS restricted to `CORS_ORIGINS`, and two-layer per-IP rate
limiting via the official `@nestjs/throttler` — a global
`RATE_LIMIT_PER_MINUTE` plus a stricter `RATE_LIMIT_AUTH_PER_MINUTE`
for credential-checking auth routes. Tune them with the school-NAT
warning in the runbook before tightening.

## Version policy

Always the latest release of every dependency, except where a documented
blocker forces a pin (recorded in `docs/adr/`). Current pins/blocks:

- NestJS apps (`api`, `worker`): TypeScript **6.0.3** — `nest build`/Nest
  toolchain does not support TypeScript 7 yet (ADR-003). Everything else: 7.0.2.
- Drizzle: `drizzle-orm@rc` / `drizzle-kit@rc` (1.0.0-rc.5) via the official
  `@nestjs/drizzle` integration, exactly as in the official NestJS Drizzle
  chapter (ADR-002).
- Test runner: Vitest everywhere — no Jest (ADR-005).

## Known simplifications

- The worker keeps a subset view of the shared DB schema in
  `apps/worker/src/db/schema.ts` (only the tables its processors touch,
  with only the columns they use); the canonical schema lives in the API,
  split per bounded context (see Conventions).
- The API `dev` script is `tsc --watch` + `node --watch` rather than the Nest
  CLI, keeping the build identical to CI (`tsc`).

## Conventions (official — see `docs/adr/`)

- **I18n is mandatory and centralized** (ADR-008): no hardcoded display
  strings. Backend/worker use the official **@nestjs/i18n** (pinned exact
  `0.0.1`) with JSON catalogs in `src/i18n/<locale>/` — default locale
  **Vietnamese**, English alongside; errors carry stable English `code`s and
  their display text is looked up by code. Frontend uses i18next +
  react-i18next with centralized resources (`apps/web/src/i18n.ts`).
- **Validation is Zod-only** (ADR-009): base schemas live in
  `packages/contracts` and are the single source of truth for the API
  (Standard Schema pipe) and React forms; server-only fields extend the
  base schema. class-validator/class-transformer are removed from the repo entirely.
- **Language of code and comments**: identifiers, API docs, log keys and
  error codes in English; **comments in Vietnamese in TSDoc style**
  (`/** */` with `@param`/`@returns`/`@throws` where fitting) for every
  public API and for non-obvious business logic.
- **Database schema is split by bounded context** (ADR-010): each module
  owns its Drizzle tables in `apps/api/src/modules/<module>/schema.ts`;
  platform-infrastructure tables live in `apps/api/src/db/infrastructure.schema.ts`;
  `apps/api/src/db/schema.ts` is only a barrel re-exporting everything for
  `drizzle.config.ts` and the Drizzle module. Table/column names never
  change when a schema file moves.
- **Naming & repo hygiene** (ADR-010): everything is named after the
  business / bounded context — **no phase labels** in code, comments, test
  names or commit subjects; **never commit compiled output** (`dist/`,
  stray `.js`/`.d.ts` next to sources). This is a writing discipline,
  upheld by authoring code correctly in the first place and by review —
  there is deliberately no automated enforcement for it.
- **Feature acceptance** (ADR-011): a feature is done only when its
  backend business flow is covered by a flow test translated from the
  Moodle PHPUnit oracle, with the mapping recorded in
  `docs/business-traceability.md`.
- **Versions are latest-first** (ADR-012): always the newest release;
  pin or downgrade only for a documented blocker recorded in an ADR
  (current blocker: TypeScript 6 for the NestJS apps — ADR-003).
