/** Các bảng của bounded context Custom Fields — định nghĩa Drizzle do module custom-fields sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Custom field categories (Moodle `customfield_category`), scoped by component+area (e.g. core_user/user). */
export const customFieldCategory = pgTable('custom_field_category', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  component: text('component').notNull(),
  area: text('area').notNull(),
  itemId: uuid('item_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('custom_field_category_item_id_idx').on(table.itemId),
  ]);


/** Custom field definitions (Moodle `customfield_field`). type: text|textarea|select|checkbox|date. config_data holds options/required/default. */
export const customFieldField = pgTable('custom_field_field', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  categoryId: uuid('category_id').notNull().references(() => customFieldCategory.id, { onDelete: 'cascade' }),
  shortName: text('short_name').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  configData: jsonb('config_data').notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('custom_field_field_category_id_idx').on(table.categoryId),
  ]);


/** Custom field values (Moodle `customfield_data`): one row per field+instance (instance = user id for profile fields). */
export const customFieldData = pgTable(
  'custom_field_data',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    fieldId: uuid('field_id').notNull().references(() => customFieldField.id, { onDelete: 'cascade' }),
    instanceId: uuid('instance_id').notNull(),
    value: text('value'),
    valueFormat: integer('value_format').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('custom_field_data_instance_id_idx').on(table.instanceId),unique('custom_field_data_unique').on(table.fieldId, table.instanceId)],
);
