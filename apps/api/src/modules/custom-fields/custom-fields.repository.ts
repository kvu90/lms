import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { customFieldCategory, customFieldData, customFieldField } from '../../db/schema';

export type CategoryRow = typeof customFieldCategory.$inferSelect;
export type FieldRow = typeof customFieldField.$inferSelect;
export type DataRow = typeof customFieldData.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu trường tuỳ biến: category, field và giá trị theo instance (component/area/item).
 */
export class CustomFieldsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  /**
   * Chèn category trường tuỳ biến.
   */
  async insertCategory(v: typeof customFieldCategory.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.db.insert(customFieldCategory).values(v).returning(); return row!;
  }
  /**
   * Liệt kê category theo component/area.
   */
  async listCategories(component: string, area: string): Promise<CategoryRow[]> {
    return this.db.select().from(customFieldCategory)
      .where(and(eq(customFieldCategory.component, component), eq(customFieldCategory.area, area)))
      .orderBy(customFieldCategory.sortOrder);
  }
  /**
   * Lấy category theo id.
   */
  async getCategory(id: string): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(customFieldCategory).where(eq(customFieldCategory.id, id)); return row;
  }
  /**
   * Xoá category.
   */
  async deleteCategory(id: string): Promise<void> {
    const fields = await this.listFieldsByCategory(id);
    for (const f of fields) await this.db.delete(customFieldData).where(eq(customFieldData.fieldId, f.id));
    await this.db.delete(customFieldField).where(eq(customFieldField.categoryId, id));
    await this.db.delete(customFieldCategory).where(eq(customFieldCategory.id, id));
  }
  /**
   * Chèn định nghĩa field.
   */
  async insertField(v: typeof customFieldField.$inferInsert): Promise<FieldRow> {
    const [row] = await this.db.insert(customFieldField).values(v).returning(); return row!;
  }
  /**
   * Lấy field theo id.
   */
  async getField(id: string): Promise<FieldRow | undefined> {
    const [row] = await this.db.select().from(customFieldField).where(eq(customFieldField.id, id)); return row;
  }
  /**
   * Liệt kê field trong category.
   */
  async listFieldsByCategory(categoryId: string): Promise<FieldRow[]> {
    return this.db.select().from(customFieldField).where(eq(customFieldField.categoryId, categoryId)).orderBy(customFieldField.sortOrder);
  }
  /**
   * Xoá field.
   */
  async deleteField(id: string): Promise<void> {
    await this.db.delete(customFieldData).where(eq(customFieldData.fieldId, id));
    await this.db.delete(customFieldField).where(eq(customFieldField.id, id));
  }
  /**
   * Ghi giá trị field cho một instance (upsert theo field+instance).
   */
  async upsertData(fieldId: string, instanceId: string, value: string | null): Promise<void> {
    await this.db.insert(customFieldData).values({ fieldId, instanceId, value })
      .onConflictDoUpdate({ target: [customFieldData.fieldId, customFieldData.instanceId], set: { value, updatedAt: new Date() } });
  }
  /**
   * Đọc mọi giá trị field của một instance.
   */
  async getDataForInstance(fieldIds: string[], instanceId: string): Promise<DataRow[]> {
    if (fieldIds.length === 0) return [];
    return this.db.select().from(customFieldData)
      .where(and(eq(customFieldData.instanceId, instanceId)));
  }
}
