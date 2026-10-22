import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Worker's view of the shared schema. P0 only needs `outbox_events` (the full
 * canonical schema lives in apps/api/src/db/schema.ts; extracting a shared
 * backend-schema package is a P1 chore, noted in the root README).
 */
export const outboxEvents = pgTable('outbox_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  aggregate: text('aggregate').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});
