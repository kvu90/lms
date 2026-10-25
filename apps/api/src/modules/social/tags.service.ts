import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { SocialRepository, type TagRow } from './social.repository';

export interface TagAreaDefinition {
  component: string;
  itemType: string;
  collection: string;
}

/**
 * Tag AREAS are registered in code (like Moodle's db/tag.php): an area says
 * which (component, itemType) pairs may be tagged and in which collection.
 * Anything not registered is refused — the polymorphic API is open in SHAPE
 * but closed in vocabulary.
 */
export const TAG_AREAS: TagAreaDefinition[] = [
  { component: 'core', itemType: 'course', collection: 'default' },
  { component: 'core', itemType: 'user', collection: 'default' },
  { component: 'core', itemType: 'course_modules', collection: 'default' },
  { component: 'core_badges', itemType: 'badge', collection: 'default' },
  { component: 'core_competency', itemType: 'competency', collection: 'default' },
];

export function normalizeTagName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * TagsModule (Moodle core_tag): tags + tag instances + correlations,
 * polymorphic over (component, itemType, itemId, contextId) with NO foreign
 * key to the tagged thing (report §2#16). Ordering is per item (oracle:
 * taglib_test test_add_tag_ordering_calculation). Correlations are the set
 * of tags co-occurring with a tag on the same items, recomputed on write.
 */
@Injectable()
/**
 * Thẻ (tags) và tương quan thẻ.
 * Đối chiếu Moodle: lib/classes/tag (core_tag). Tag thuộc collection theo area;
 * correlation được tính từ đồng xuất hiện trên cùng item.
 */
export class TagsService {
  constructor(
    private readonly repo: SocialRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
  ) {}

  /**
   * The capability alone is not the whole law for course-scoped items: the
   * virtual 'user' role carries tag:edit, so for course/module contexts the
   * actor must ALSO have real course access (enrolled or staff) — the same
   * enrol gate CoursesService enforces everywhere else.
   */
  private async assertItemAccess(actorId: string, contextId: string): Promise<void> {
    const ctx = await this.contexts.getContext(contextId).catch(() => undefined);
    if (!ctx) return;
    if (ctx.contextLevel === 50) await this.courses.assertCourseAccess(actorId, ctx.instanceId!);
    if (ctx.contextLevel === 70) {
      const cm = await this.courses.getCm(ctx.instanceId!);
      await this.courses.assertCourseAccess(actorId, cm.course);
    }
  }

  /**
   * Các tag area đã khai báo.
   */
  listAreas(): TagAreaDefinition[] { return TAG_AREAS; }
  /**
   * Các tag collection.
   */
  async listCollections() {
    await this.repo.ensureDefaultCollection();
    return this.repo.listCollections();
  }

  private assertArea(component: string, itemType: string): void {
    if (!TAG_AREAS.some((a) => a.component === component && a.itemType === itemType)) {
      throw new BadRequestException({
        message: `No tag area registered for ${component}/${itemType}`,
        code: 'tags.area_not_registered',
      });
    }
  }

  private async getOrCreateTag(actorId: string, rawName: string): Promise<TagRow> {
    const collId = await this.repo.ensureDefaultCollection();
    const name = normalizeTagName(rawName);
    const existing = await this.repo.findTag(collId, name);
    if (existing) return existing;
    return this.repo.insertTag({ userId: actorId, tagCollId: collId, name, rawName: rawName.trim() });
  }

  /** set_item_tags: replace the tag set of one item (oracle: taglib_test test_add_remove_item_tag). */
  /**
   * Đặt toàn bộ tag của item (thay thế).
   */
  async setItemTags(actorId: string, input: {
    component: string; itemType: string; itemId: string; contextId: string; tags: string[];
  }): Promise<{ tags: (TagRow & { ordering: number })[] }> {
    this.assertArea(input.component, input.itemType);
    await this.evaluator.requireCapability(actorId, 'tag:edit', input.contextId);
    await this.assertItemAccess(actorId, input.contextId);
    await this.repo.deleteInstancesForItem(input.component, input.itemType, input.itemId, input.contextId);
    const seen = new Set<string>();
    const result: (TagRow & { ordering: number })[] = [];
    let ordering = 0;
    for (const raw of input.tags) {
      const normalized = normalizeTagName(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordering += 1;
      const tagRow = await this.getOrCreateTag(actorId, raw);
      const instance = await this.repo.insertInstance({
        tagId: tagRow.id, component: input.component, itemType: input.itemType,
        itemId: input.itemId, contextId: input.contextId, tiUserId: null, ordering,
      });
      result.push({ ...tagRow, ordering: instance.ordering });
    }
    await this.recomputeCorrelations(result.map((t) => t.id));
    return { tags: result };
  }

  /** add_item_tag: append a single tag (idempotent per item). */
  /**
   * Gắn thêm một tag vào item.
   */
  async addItemTag(actorId: string, input: { component: string; itemType: string; itemId: string; contextId: string; tag: string }) {
    const current = await this.listItemTags(input.component, input.itemType, input.itemId);
    const names = current.map((t) => t.name);
    if (!names.includes(normalizeTagName(input.tag))) names.push(normalizeTagName(input.tag));
    return this.setItemTags(actorId, { ...input, tags: names });
  }

  /**
   * Tag của item. Các caller nội bộ (add/remove) không truyền viewerId;
   * đường ghi của chúng đi qua setItemTags vốn đã gác theo actor.
   */
  async listItemTags(component: string, itemType: string, itemId: string, viewerId?: string): Promise<(TagRow & { ordering: number })[]> {
    void viewerId;
    const instances = await this.repo.listInstancesForItem(component, itemType, itemId);
    const out: (TagRow & { ordering: number })[] = [];
    for (const instance of instances) {
      const tagRow = await this.repo.getTag(instance.tagId);
      if (tagRow) out.push({ ...tagRow, ordering: instance.ordering });
    }
    return out;
  }

  /**
   * Gỡ một tag khỏi item.
   */
  async removeItemTag(actorId: string, input: { component: string; itemType: string; itemId: string; contextId: string; tag: string }) {
    const current = await this.listItemTags(input.component, input.itemType, input.itemId);
    const remaining = current.filter((t) => t.name !== normalizeTagName(input.tag)).map((t) => t.rawName);
    return this.setItemTags(actorId, { ...input, tags: remaining });
  }

  /** Correlated tags: other tags appearing on items this tag also appears on. */
  private async recomputeCorrelations(tagIds: string[]): Promise<void> {
    for (const tagId of tagIds) {
      const instances = await this.repo.listInstancesForTag(tagId);
      const correlated = new Set<string>();
      for (const instance of instances) {
        const siblings = await this.repo.listInstancesForItem(instance.component, instance.itemType, instance.itemId);
        for (const sibling of siblings) {
          if (sibling.tagId !== tagId) correlated.add(sibling.tagId);
        }
      }
      await this.repo.upsertCorrelation(tagId, [...correlated].sort().join(','));
    }
  }

  /**
   * Tag liên quan (đồng xuất hiện nhiều) với tag cho trước.
   */
  async getCorrelated(tagId: string): Promise<{ tagId: string; correlatedTags: string[] }> {
    const tagRow = await this.repo.getTag(tagId);
    if (!tagRow) throw new NotFoundException({ message: `Tag ${tagId} not found`, code: 'tags.not_found' });
    const row = await this.repo.getCorrelation(tagId);
    return {
      tagId: tagId,
      correlatedTags: row?.correlatedTags ? row.correlatedTags.split(',').filter(Boolean) : [],
    };
  }
}
