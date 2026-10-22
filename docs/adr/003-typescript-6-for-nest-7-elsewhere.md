# ADR-003: TypeScript 6.0.3 for NestJS apps, 7.0.2 everywhere else

- Status: accepted (2026-10-22)

## Decision

- `apps/api`, `apps/worker`: TypeScript **6.0.3** (pnpm catalog `catalog:nest`).
- `apps/web`, `packages/*`, root tooling: TypeScript **7.0.2** (`catalog:`).

## Blocker (why not latest everywhere)

**Block:** the NestJS toolchain (`nest build`, decorator-metadata emit and
the Nest 12 compiler pipeline) does not support TypeScript 7 yet — project
policy is "latest unless a documented blocker exists"; this is that blocker.
Re-check when Nest publishes TS 7 support, then collapse both lines to 7.x
and delete this ADR's split.
