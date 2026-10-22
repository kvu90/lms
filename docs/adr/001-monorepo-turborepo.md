# ADR-001: Monorepo with Turborepo 2.x + pnpm workspaces

- Status: accepted (2026-10-22)

## Decision

One repo, Turborepo 2.x (`turbo.json` uses the `tasks` key and the
`https://turborepo.dev/schema.json` schema), pnpm workspaces with a version
catalog for dependencies shared across packages. Apps: `api`, `worker`,
`web`. Shared packages: `contracts`, `config`.

## Why

The product spans a NestJS backend, a separate worker process and an
independent React frontend that must share exactly one contract surface.
Turborepo's task graph (`build` before `typecheck`/`lint`/`test` via
`^build`) enforces that ordering with caching; Nest's own monorepo mode only
covers backend apps.
