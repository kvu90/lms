# @lms/worker

NestJS 12 worker process (no HTTP): BullMQ processors, the outbox relay and
scheduled jobs. Shares the database and Redis with the API; business modules
stay in the API in P0 and are extracted only when a context needs its own
process (see report §3.12).

```bash
pnpm build && pnpm start
```
