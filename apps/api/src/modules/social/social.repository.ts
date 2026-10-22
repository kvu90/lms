import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  blogAssociation, blogPosts, comments, notes, rating, tag, tagCollection, tagCorrelation, tagInstance,
} from '../../db/schema';

export type TagRow = typeof tag.$inferSelect;
export type TagInstanceRow = typeof tagInstance.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type RatingRow = typeof rating.$inferSelect;
export type BlogPostRow = typeof blogPosts.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu xã hội: tag + tag instance + correlation, comment, rating, blog post + association và course note.
 */
export class SocialRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // tags
  /**
   * Đảm bảo collection tag mặc định tồn tại.
   */
  async ensureDefaultCollection(): Promise<string> {
    const [existing] = await this.db.select().from(tagCollection).where(eq(tagCollection.name, 'Default collection'));
    if (existing) return existing.id;
    const [row] = await this.db.insert(tagCollection).values({ name: 'Default collection', isstandard: true }).returning();
    return row!.id;
  }
  /**
   * Liệt kê tag collection.
   */
  async listCollections() { return this.db.select().from(tagCollection).orderBy(asc(tagCollection.id)); }
  /**
   * Tìm tag theo tên trong collection.
   */
  async findTag(tagcollid: string, name: string): Promise<TagRow | undefined> {
    const [row] = await this.db.select().from(tag).where(and(eq(tag.tagcollid, tagcollid), eq(tag.name, name)));
    return row;
  }
  /**
   * Chèn tag (chính thức hoặc cá nhân).
   */
  async insertTag(v: typeof tag.$inferInsert): Promise<TagRow> {
    const [row] = await this.db.insert(tag).values(v).returning(); return row!;
  }
  /**
   * Lấy tag theo id.
   */
  async getTag(id: string): Promise<TagRow | undefined> {
    const [row] = await this.db.select().from(tag).where(eq(tag.id, id)); return row;
  }
  /**
   * Tag instance gắn với một item.
   */
  async listInstancesForItem(component: string, itemtype: string, itemid: string): Promise<TagInstanceRow[]> {
    return this.db.select().from(tagInstance)
      .where(and(eq(tagInstance.component, component), eq(tagInstance.itemtype, itemtype), eq(tagInstance.itemid, itemid)))
      .orderBy(asc(tagInstance.ordering));
  }
  /**
   * Item đã gắn một tag.
   */
  async listInstancesForTag(tagid: string): Promise<TagInstanceRow[]> {
    return this.db.select().from(tagInstance).where(eq(tagInstance.tagid, tagid));
  }
  /**
   * Gắn tag vào item.
   */
  async insertInstance(v: typeof tagInstance.$inferInsert): Promise<TagInstanceRow> {
    const [row] = await this.db.insert(tagInstance).values(v)
      .onConflictDoNothing({ target: [tagInstance.tagid, tagInstance.component, tagInstance.itemtype, tagInstance.itemid, tagInstance.contextid, tagInstance.tiuserid] })
      .returning();
    if (row) return row;
    const [existing] = await this.db.select().from(tagInstance).where(and(
      eq(tagInstance.tagid, v.tagid), eq(tagInstance.component, v.component), eq(tagInstance.itemtype, v.itemtype),
      eq(tagInstance.itemid, v.itemid), eq(tagInstance.contextid, v.contextid), v.tiuserid ? eq(tagInstance.tiuserid, v.tiuserid) : isNull(tagInstance.tiuserid),
    ));
    return existing!;
  }
  /**
   * Gỡ mọi tag của item.
   */
  async deleteInstancesForItem(component: string, itemtype: string, itemid: string, contextid: string): Promise<void> {
    await this.db.delete(tagInstance).where(and(
      eq(tagInstance.component, component), eq(tagInstance.itemtype, itemtype),
      eq(tagInstance.itemid, itemid), eq(tagInstance.contextid, contextid),
    ));
  }
  /**
   * Ghi độ tương quan giữa hai tag (tag liên quan).
   */
  async upsertCorrelation(tagid: string, correlatedtags: string): Promise<void> {
    await this.db.insert(tagCorrelation).values({ tagid, correlatedtags })
      .onConflictDoUpdate({ target: tagCorrelation.tagid, set: { correlatedtags } });
  }
  /**
   * Độ tương quan đã lưu của một tag.
   */
  async getCorrelation(tagid: string) {
    const [row] = await this.db.select().from(tagCorrelation).where(eq(tagCorrelation.tagid, tagid));
    return row;
  }

  // comments
  /**
   * Chèn comment.
   */
  async insertComment(v: typeof comments.$inferInsert): Promise<CommentRow> {
    const [row] = await this.db.insert(comments).values(v).returning(); return row!;
  }
  /**
   * Lấy comment theo id.
   */
  async getComment(id: string): Promise<CommentRow | undefined> {
    const [row] = await this.db.select().from(comments).where(eq(comments.id, id)); return row;
  }
  /**
   * Comment của một item theo context.
   */
  async listComments(component: string, commentarea: string, itemid: string, contextid: string): Promise<CommentRow[]> {
    return this.db.select().from(comments).where(and(
      eq(comments.component, component), eq(comments.commentarea, commentarea),
      eq(comments.itemid, itemid), eq(comments.contextid, contextid), isNull(comments.timedeleted),
    )).orderBy(desc(comments.id));
  }
  /**
   * Xoá mềm comment.
   */
  async softDeleteComment(id: string): Promise<void> {
    await this.db.update(comments).set({ timedeleted: new Date() }).where(eq(comments.id, id));
  }

  // ratings
  /**
   * Ghi/cập nhật rating của user cho item.
   */
  async upsertRating(v: typeof rating.$inferInsert): Promise<RatingRow> {
    const [row] = await this.db.insert(rating).values(v).onConflictDoUpdate({
      target: [rating.contextid, rating.component, rating.ratingarea, rating.itemid, rating.userid],
      set: { rating: v.rating, scaleid: v.scaleid, timemodified: new Date() },
    }).returning();
    return row!;
  }
  /**
   * Rating của một item.
   */
  async listRatings(component: string, ratingarea: string, itemid: string, contextid: string): Promise<RatingRow[]> {
    return this.db.select().from(rating).where(and(
      eq(rating.component, component), eq(rating.ratingarea, ratingarea),
      eq(rating.itemid, itemid), eq(rating.contextid, contextid),
    )).orderBy(asc(rating.id));
  }

  // blog
  /**
   * Chèn bài blog.
   */
  async insertPost(v: typeof blogPosts.$inferInsert): Promise<BlogPostRow> {
    const [row] = await this.db.insert(blogPosts).values(v).returning(); return row!;
  }
  /**
   * Lấy bài blog theo id.
   */
  async getPost(id: string): Promise<BlogPostRow | undefined> {
    const [row] = await this.db.select().from(blogPosts).where(eq(blogPosts.id, id)); return row;
  }
  /**
   * Liệt kê bài blog.
   */
  async listPosts(): Promise<BlogPostRow[]> {
    return this.db.select().from(blogPosts).orderBy(desc(blogPosts.id));
  }
  /**
   * Bài blog của user.
   */
  async listPostsByUser(userid: string): Promise<BlogPostRow[]> {
    return this.db.select().from(blogPosts).where(eq(blogPosts.userid, userid)).orderBy(desc(blogPosts.id));
  }
  /**
   * Cập nhật bài blog.
   */
  async updatePost(id: string, patch: Partial<BlogPostRow>): Promise<void> {
    await this.db.update(blogPosts).set({ ...patch, lastmodified: new Date() }).where(eq(blogPosts.id, id));
  }
  /**
   * Xoá bài blog.
   */
  async deletePost(id: string): Promise<void> {
    await this.db.delete(blogPosts).where(eq(blogPosts.id, id));
  }
  /**
   * Gắn bài blog với khoá học/module.
   */
  async addAssociation(v: typeof blogAssociation.$inferInsert): Promise<void> {
    await this.db.insert(blogAssociation).values(v).onConflictDoNothing();
  }
  /**
   * Association của bài blog.
   */
  async listAssociations(blogid: string) {
    return this.db.select().from(blogAssociation).where(eq(blogAssociation.blogid, blogid));
  }
  /**
   * Bài blog gắn với một khoá học/module.
   */
  async listAssociationsForTarget(assoctype: string, associd: string) {
    return this.db.select().from(blogAssociation)
      .where(and(eq(blogAssociation.assoctype, assoctype), eq(blogAssociation.associd, associd)));
  }

  // notes
  /**
   * Chèn course note.
   */
  async insertNote(v: typeof notes.$inferInsert): Promise<NoteRow> {
    const [row] = await this.db.insert(notes).values(v).returning(); return row!;
  }
  /**
   * Lấy note theo id.
   */
  async getNote(id: string): Promise<NoteRow | undefined> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id)); return row;
  }
  /**
   * Note viết về một user.
   */
  async listNotesAbout(userid: string): Promise<NoteRow[]> {
    return this.db.select().from(notes).where(eq(notes.userid, userid)).orderBy(desc(notes.id));
  }
  /**
   * Xoá note.
   */
  async deleteNote(id: string): Promise<void> {
    await this.db.delete(notes).where(eq(notes.id, id));
  }
}
