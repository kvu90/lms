# ADR-004: Transactional outbox, self-built

- Status: accepted (2026-10-22)

## Decision

Domain events that must not be lost are written to the `outbox_events` table
in the same database transaction as the business change. A relay (API-side
`OutboxRelayService`, worker-side `OutboxRelayScheduler`) publishes committed
rows to the EventEmitter/BullMQ and only then marks `published_at`.
In-process EventEmitter2 alone is never used for must-not-lose effects.

## Why

NestJS has no official outbox package (research report §3.4). The pattern is
small, testable (rollback ⇒ no event, proven by an integration test against
the real database) and is the backbone for search indexing, notifications,
badges and enrolment side-effects in later phases.
