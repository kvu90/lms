# ADR-005: Vitest as the only test runner

- Status: accepted (2026-10-22)

## Decision

Vitest for the whole monorepo (backend unit/integration/e2e with Supertest,
frontend with Testing Library). No Jest anywhere. NestJS apps configure
`unplugin-swc` so SWC emits decorator metadata that Nest DI requires
(esbuild/Vite alone cannot). File parallelism is disabled in the backend
suites that share the real `lms_test` database and local Redis.

## Why

Vitest is the default of newly generated NestJS 12 projects (current Nest
testing docs) and one runner across api/worker/web keeps CI, coverage and
the business-flow-test discipline (report §3.11) uniform.
