# @lms/api

NestJS 12 backend (TypeScript 6.0.3 — see ADR-003). Boot:

```bash
cp .env.example .env   # local defaults point at localhost Postgres/Redis
pnpm db:migrate        # apply drizzle migrations
pnpm build && pnpm start
# GET http://localhost:3000/api/v1/health
# OpenAPI: http://localhost:3000/api/docs
```

Tests (Vitest + unplugin-swc, Supertest for e2e) run against `lms_test` +
the real local Redis: `pnpm test`.
