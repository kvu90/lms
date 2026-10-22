/** Các bảng của bounded context Custom Fields — định nghĩa Drizzle do module custom-fields sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Custom field categories (Moodle `customfield_category`), scoped by component+area (e.g. core_user/user). */
export const customfieldCategory = pgTable('customfield_category', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  component: text('component').notNull(),
  area: text('area').notNull(),
  itemid: integer('itemid').notNull().default(0),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Custom field definitions (Moodle `customfield_field`). type: text|textarea|select|checkbox|date. configdata holds options/required/default. */
export const customfieldField = pgTable('customfield_field', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  categoryid: integer('categoryid').notNull().references(() => customfieldCategory.id, { onDelete: 'cascade' }),
  shortname: text('shortname').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  configdata: jsonb('configdata').notNull().default({}),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Custom field values (Moodle `customfield_data`): one row per field+instance (instance = user id for profile fields). */
export const customfieldData = pgTable(
  'customfield_data',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    fieldid: integer('fieldid').notNull().references(() => customfieldField.id, { onDelete: 'cascade' }),
    instanceid: integer('instanceid').notNull(),
    value: text('value'),
    valueformat: integer('valueformat').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('customfield_data_unique').on(table.fieldid, table.instanceid)],
);
