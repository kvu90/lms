import { defineRelations } from 'drizzle-orm';
import * as schema from '@lms/db-schema';

export const relations = defineRelations(schema, () => ({}));
