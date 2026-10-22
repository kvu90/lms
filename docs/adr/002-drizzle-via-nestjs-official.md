# ADR-002: Drizzle ORM via the official @nestjs/drizzle integration (v1 rc)

- Status: accepted (2026-10-22)

## Decision

Use Drizzle ORM as the only ORM, integrated exactly as documented in the
official NestJS Drizzle chapter (https://docs.nestjs.com/data/drizzle):
`DrizzleModule.forRootAsync()` with the `drizzle()` function from
`drizzle-orm/node-postgres`, `@InjectDrizzle()` injection, relations declared
with `defineRelations()`, repositories hand-written as providers, migrations
via drizzle-kit (`generate` → review SQL → `migrate`; never `push` outside
dev, never auto-migrate on multi-instance boot).

Versions: `drizzle-orm@rc` = 1.0.0-rc.5, `drizzle-kit@rc` = 1.0.0-rc.5,
`@nestjs/drizzle` (latest).

## Why / trade-offs

The official chapter is written for Drizzle v1 (published under the `rc`
tag) and `@nestjs/drizzle` also supports v0.35+. Starting from zero, we
follow the documented v1 line rather than mixing two relation APIs.
Accepted cost (from the research report §3.2): Drizzle has no repository
pattern / Unit of Work / identity map — repositories are hand-written behind
domain interfaces and transactions are passed explicitly.
