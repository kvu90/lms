import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { customfieldCategory, customfieldData, customfieldField } from '../../db/schema';

export type CategoryRow = typeof customfieldCategory.$inferSelect;
export type FieldRow = typeof customfieldField.$inferSelect;
export type DataRow = typeof customfieldData.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu trường tuỳ biến: category, field và giá trị theo instance (component/area/item).
 */
export class CustomFieldsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  /**
   * Chèn category trường tuỳ biến.
   */
  async insertCategory(v: typeof customfieldCategory.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.db.insert(customfieldCategory).values(v).returning(); return row!;
  }
  /**
   * Liệt kê category theo component/area.
   */
  async listCategories(component: string, area: string): Promise<CategoryRow[]> {
    return this.db.select().from(customfieldCategory)
      .where(and(eq(customfieldCategory.component, component), eq(customfieldCategory.area, area)))
      .orderBy(customfieldCategory.sortorder);
  }
  /**
   * Lấy category theo id.
   */
  async getCategory(id: string): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(customfieldCategory).where(eq(customfieldCategory.id, id)); return row;
  }
  /**
   * Xoá category.
   */
  async deleteCategory(id: string): Promise<void> {
    const fields = await this.listFieldsByCategory(id);
    for (const f of fields) await this.db.delete(customfieldData).where(eq(customfieldData.fieldid, f.id));
    await this.db.delete(customfieldField).where(eq(customfieldField.categoryid, id));
    await this.db.delete(customfieldCategory).where(eq(customfieldCategory.id, id));
  }
  /**
   * Chèn định nghĩa field.
   */
  async insertField(v: typeof customfieldField.$inferInsert): Promise<FieldRow> {
    const [row] = await this.db.insert(customfieldField).values(v).returning(); return row!;
  }
  /**
   * Lấy field theo id.
   */
  async getField(id: string): Promise<FieldRow | undefined> {
    const [row] = await this.db.select().from(customfieldField).where(eq(customfieldField.id, id)); return row;
  }
  /**
   * Liệt kê field trong category.
   */
  async listFieldsByCategory(categoryid: string): Promise<FieldRow[]> {
    return this.db.select().from(customfieldField).where(eq(customfieldField.categoryid, categoryid)).orderBy(customfieldField.sortorder);
  }
  /**
   * Xoá field.
   */
  async deleteField(id: string): Promise<void> {
    await this.db.delete(customfieldData).where(eq(customfieldData.fieldid, id));
    await this.db.delete(customfieldField).where(eq(customfieldField.id, id));
  }
  /**
   * Ghi giá trị field cho một instance (upsert theo field+instance).
   */
  async upsertData(fieldid: string, instanceid: string, value: string | null): Promise<void> {
    await this.db.insert(customfieldData).values({ fieldid, instanceid, value })
      .onConflictDoUpdate({ target: [customfieldData.fieldid, customfieldData.instanceid], set: { value, timemodified: new Date() } });
  }
  /**
   * Đọc mọi giá trị field của một instance.
   */
  async getDataForInstance(fieldIds: string[], instanceid: string): Promise<DataRow[]> {
    if (fieldIds.length === 0) return [];
    return this.db.select().from(customfieldData)
      .where(and(eq(customfieldData.instanceid, instanceid)));
  }
}
