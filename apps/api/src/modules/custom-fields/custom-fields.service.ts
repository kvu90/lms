import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CustomFieldsRepository, type FieldRow } from './custom-fields.repository';

export type CustomFieldType = 'text' | 'textarea' | 'select' | 'checkbox' | 'date';
export interface FieldConfig { required?: boolean; options?: string[]; defaultvalue?: string; maxlength?: number }
export const FIELD_TYPES: CustomFieldType[] = ['text', 'textarea', 'select', 'checkbox', 'date'];

/**
 * CustomFields facade (Moodle core_customfield). Definitions are metadata —
 * business tables are never altered. Values are validated against the field
 * declaration whenever the owning entity (user profile) is saved.
 */
@Injectable()
/**
 * Trường tuỳ biến cho user/khoá học: định nghĩa theo category, kiểu dữ liệu (text, textarea, select, checkbox, datetime, password)
 * và kiểm tra giá trị theo configData của từng field trước khi lưu.
 * Đối chiếu Moodle: customfield_* (customfield/classes/handler.php).
 */
export class CustomFieldsService {
  constructor(private readonly repo: CustomFieldsRepository) {}

  /**
   * Tạo category trường cho một component/area.
   */
  async createCategory(input: { name: string; component: string; area: string }): Promise<unknown> {
    const existing = await this.repo.listCategories(input.component, input.area);
    return this.repo.insertCategory({ ...input, sortOrder: existing.length });
  }
  /**
   * Liệt kê category.
   */
  async listCategories(component: string, area: string): Promise<unknown[]> { return this.repo.listCategories(component, area); }
  /**
   * Xoá category.
   */
  async deleteCategory(id: string): Promise<void> {
    if (!(await this.repo.getCategory(id))) throw new NotFoundException({ message: `Category ${id} not found`, code: 'customfield.category_not_found' });
    await this.repo.deleteCategory(id);
  }
  /**
   * Tạo field trong category với configData theo kiểu dữ liệu.
   */
  async createField(categoryId: string, input: { shortName: string; name: string; type: string; configData?: FieldConfig }): Promise<FieldRow> {
    const category = await this.repo.getCategory(categoryId);
    if (!category) throw new NotFoundException({ message: `Category ${categoryId} not found`, code: 'customfield.category_not_found' });
    if (!FIELD_TYPES.includes(input.type as CustomFieldType)) {
      throw new BadRequestException({ message: `Unsupported field type ${input.type}`, code: 'customfield.invalid_type' });
    }
    const siblings = await this.repo.listFieldsByCategory(categoryId);
    if (siblings.some((f) => f.shortName === input.shortName)) {
      throw new BadRequestException({ message: `Field shortName ${input.shortName} already exists in category`, code: 'customfield.shortname_taken' });
    }
    return this.repo.insertField({ categoryId, shortName: input.shortName, name: input.name, type: input.type, configData: input.configData ?? {}, sortOrder: siblings.length });
  }
  /**
   * Liệt kê field của category.
   */
  async listFields(component: string, area: string): Promise<FieldRow[]> {
    const categories = await this.repo.listCategories(component, area);
    const all: FieldRow[] = [];
    for (const c of categories) all.push(...(await this.repo.listFieldsByCategory(c.id)));
    return all;
  }
  /**
   * Xoá field và giá trị của nó.
   */
  async deleteField(id: string): Promise<void> {
    if (!(await this.repo.getField(id))) throw new NotFoundException({ message: `Field ${id} not found`, code: 'customfield.field_not_found' });
    await this.repo.deleteField(id);
  }

  /** Validate a value against its field declaration; returns an error message or null. Pure business rule per type. */
  /**
   * Kiểm một giá trị theo định nghĩa field (bắt buộc, độ dài, danh sách lựa chọn của select, định dạng datetime).
   */
  validateValue(field: FieldRow, raw: string | undefined | null): string | null {
    const config = (field.configData ?? {}) as FieldConfig;
    const value = raw ?? '';
    if (config.required && value.trim() === '') return `Field ${field.shortName} is required`;
    if (value === '') return null;
    switch (field.type) {
      case 'text':
        if (config.maxlength && value.length > config.maxlength) return `Field ${field.shortName} exceeds ${config.maxlength} characters`;
        return null;
      case 'textarea': return null;
      case 'select':
        return (config.options ?? []).includes(value) ? null : `Field ${field.shortName} must be one of: ${(config.options ?? []).join(', ')}`;
      case 'checkbox':
        return ['0', '1', 'true', 'false'].includes(value) ? null : `Field ${field.shortName} must be a boolean value`;
      case 'date':
        return Number.isNaN(Date.parse(value)) ? `Field ${field.shortName} must be a valid date` : null;
      default: return `Unknown field type ${field.type}`;
    }
  }

  /** Validate-only pass (no writes) — callers run this BEFORE persisting the owning entity so a bad profile never leaves a half-created record. */
  /**
   * Kiểm toàn bộ bộ giá trị của một instance trước khi ghi.
   */
  async validateValuesForInstance(component: string, area: string, values: Record<string, string>): Promise<void> {
    const fields = await this.listFields(component, area);
    const errors: string[] = [];
    for (const field of fields) {
      const err = this.validateValue(field, values[field.shortName]);
      if (err) errors.push(err);
    }
    if (errors.length) throw new BadRequestException({ message: errors.join('; '), code: 'customfield.validation_failed' });
  }

  /** Validate + persist all values for an instance (e.g. a user id). Throws 400 listing every violation. */
  /**
   * Ghi các giá trị field cho instance sau khi kiểm hợp lệ.
   */
  async setValuesForInstance(component: string, area: string, instanceId: string, values: Record<string, string>): Promise<void> {
    const fields = await this.listFields(component, area);
    const errors: string[] = [];
    for (const field of fields) {
      const err = this.validateValue(field, values[field.shortName]);
      if (err) errors.push(err);
    }
    if (errors.length) throw new BadRequestException({ message: errors.join('; '), code: 'customfield.validation_failed' });
    for (const field of fields) {
      if (values[field.shortName] !== undefined) await this.repo.upsertData(field.id, instanceId, values[field.shortName]!);
    }
  }
  /**
   * Đọc giá trị field của instance để hiển thị hồ sơ.
   */
  async getValuesForInstance(component: string, area: string, instanceId: string): Promise<{ field: FieldRow; value: string | null }[]> {
    const fields = await this.listFields(component, area);
    const data = await this.repo.getDataForInstance(fields.map((f) => f.id), instanceId);
    return fields.map((field) => ({ field, value: data.find((d) => d.fieldId === field.id)?.value ?? null }));
  }
}
