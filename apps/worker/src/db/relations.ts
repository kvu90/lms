import { defineRelations } from 'drizzle-orm';
import * as schema from '@lms/db';

export const relations = defineRelations(schema, () => ({}));
