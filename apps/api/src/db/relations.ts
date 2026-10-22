import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

/**
 * Relations for the infrastructure schema (per the official NestJS Drizzle
 * chapter). The infra tables are intentionally unrelated; feature modules add
 * their relations here.
 */
export const relations = defineRelations(schema, () => ({}));
