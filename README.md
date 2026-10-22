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
- PostgreSQL 16 at `localhost:5432` (user `postgres`/`postgres`, DBs `lms` and `lms_test`)
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

## Verify (definition of green)

```bash
pnpm install
turbo run build typecheck lint test
```

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

- The worker keeps a minimal copy of the shared DB schema (only
  `outbox_events`); extracting a shared backend-schema package is a future chore.
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
  base schema. No class-validator for new code.
- **Language of code and comments**: identifiers, API docs, log keys and
  error codes in English; **comments in Vietnamese in TSDoc style**
  (`/** */` with `@param`/`@returns`/`@throws` where fitting) for every
  public API and for non-obvious business logic.
- **Naming & repo hygiene** (ADR-010): everything is named after the
  business / bounded context — **no phase labels** in code, comments, test
  names or commit subjects; **never commit compiled output** (`dist/`,
  stray `.js`/`.d.ts` next to sources). Run
  `node scripts/check-repo-hygiene.mjs` before committing.
- **Feature acceptance** (ADR-011): a feature is done only when its
  backend business flow is covered by a flow test translated from the
  Moodle PHPUnit oracle, with the mapping recorded in
  `docs/business-traceability.md`.
- **Versions are latest-first** (ADR-012): always the newest release;
  pin or downgrade only for a documented blocker recorded in an ADR
  (current blocker: TypeScript 6 for the NestJS apps — ADR-003).
