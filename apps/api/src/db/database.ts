import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './relations';

export type Database = NodePgDatabase<typeof relations>;
