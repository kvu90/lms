# Business traceability — Moodle tests → our tests

Per the project standard (research report §3.11): a feature is done only when
its **business flow** is covered by flow-level tests, and the behavioural
oracle is Moodle's own PHPUnit test suite, translated scenario-by-scenario.
Every phase appends its mapping here: Moodle test file/case → our test file
→ status. Cases that encode PHP implementation details rather than business
behaviour are skipped with a recorded reason.

## Structure (template for P1+)

| # | Behaviour | Moodle oracle (file / case) | Our test | Phase | Status |
|---|-----------|-----------------------------|----------|-------|--------|
|   |           |                             |          |       |        |

## P0 — Infrastructure (no business subsystems yet)

P0 deliberately ships no Moodle business behaviour, so there are no Moodle
oracle mappings yet. The P0 acceptance tests verify the infrastructure
contracts the later business flows rely on:

| Behaviour under test | Our test |
|----------------------|----------|
| Outbox: event published only after commit; rollback ⇒ no event | `apps/api/src/infra/events/outbox.spec.ts` |
| BullMQ adhoc dedup by jobId (Moodle adhoc-task dedup semantics, report §3.5) | `apps/api/src/infra/tasks/tasks.spec.ts` |
| Scheduled job runs once across two instances (Redis lock) | `apps/api/src/infra/tasks/tasks.spec.ts` |
| Cache MUC modes stay namespace-isolated (application / session / request) | `apps/api/src/infra/cache/cache-infra.spec.ts` |
| RFC 7807 Problem Details shape for all API errors | `apps/api/src/common/problem-details.filter.spec.ts`, `apps/api/test/app.e2e-spec.ts` |
| Env validation fails fast at boot | `apps/api/src/config/env.spec.ts` |
| Shared api↔web contracts parse/reject correctly | `packages/contracts/src/contracts.spec.ts` |
| Worker boots; sample processor + outbox relay work | `apps/worker/test/worker.smoke.spec.ts` |
| Web health page renders live API status | `apps/web/src/pages/health.spec.tsx` |
