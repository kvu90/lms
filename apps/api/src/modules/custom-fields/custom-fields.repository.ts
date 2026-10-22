import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { customfieldCategory, customfieldData, customfieldField } from '../../db/schema';

export type CategoryRow = typeof customfieldCategory.$inferSelect;
export type FieldRow = typeof customfieldField.$inferSelect;
export type DataRow = typeof customfieldData.$inferSelect;

@Injectable()
export class CustomFieldsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  async insertCategory(v: typeof customfieldCategory.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.db.insert(customfieldCategory).values(v).returning(); return row!;
  }
  async listCategories(component: string, area: string): Promise<CategoryRow[]> {
    return this.db.select().from(customfieldCategory)
      .where(and(eq(customfieldCategory.component, component), eq(customfieldCategory.area, area)))
      .orderBy(customfieldCategory.sortorder);
  }
  async getCategory(id: number): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(customfieldCategory).where(eq(customfieldCategory.id, id)); return row;
  }
  async deleteCategory(id: number): Promise<void> {
    const fields = await this.listFieldsByCategory(id);
    for (const f of fields) await this.db.delete(customfieldData).where(eq(customfieldData.fieldid, f.id));
    await this.db.delete(customfieldField).where(eq(customfieldField.categoryid, id));
    await this.db.delete(customfieldCategory).where(eq(customfieldCategory.id, id));
  }
  async insertField(v: typeof customfieldField.$inferInsert): Promise<FieldRow> {
    const [row] = await this.db.insert(customfieldField).values(v).returning(); return row!;
  }
  async getField(id: number): Promise<FieldRow | undefined> {
    const [row] = await this.db.select().from(customfieldField).where(eq(customfieldField.id, id)); return row;
  }
  async listFieldsByCategory(categoryid: number): Promise<FieldRow[]> {
    return this.db.select().from(customfieldField).where(eq(customfieldField.categoryid, categoryid)).orderBy(customfieldField.sortorder);
  }
  async deleteField(id: number): Promise<void> {
    await this.db.delete(customfieldData).where(eq(customfieldData.fieldid, id));
    await this.db.delete(customfieldField).where(eq(customfieldField.id, id));
  }
  async upsertData(fieldid: number, instanceid: number, value: string | null): Promise<void> {
    await this.db.insert(customfieldData).values({ fieldid, instanceid, value })
      .onConflictDoUpdate({ target: [customfieldData.fieldid, customfieldData.instanceid], set: { value, timemodified: new Date() } });
  }
  async getDataForInstance(fieldIds: number[], instanceid: number): Promise<DataRow[]> {
    if (fieldIds.length === 0) return [];
    return this.db.select().from(customfieldData)
      .where(and(eq(customfieldData.instanceid, instanceid)));
  }
}
