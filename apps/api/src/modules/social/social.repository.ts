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
export class SocialRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // tags
  async ensureDefaultCollection(): Promise<number> {
    const [existing] = await this.db.select().from(tagCollection).where(eq(tagCollection.id, 1));
    if (existing) return existing.id;
    const [row] = await this.db.insert(tagCollection).values({ name: 'Default collection', isstandard: true }).returning();
    return row!.id;
  }
  async listCollections() { return this.db.select().from(tagCollection).orderBy(asc(tagCollection.id)); }
  async findTag(tagcollid: number, name: string): Promise<TagRow | undefined> {
    const [row] = await this.db.select().from(tag).where(and(eq(tag.tagcollid, tagcollid), eq(tag.name, name)));
    return row;
  }
  async insertTag(v: typeof tag.$inferInsert): Promise<TagRow> {
    const [row] = await this.db.insert(tag).values(v).returning(); return row!;
  }
  async getTag(id: number): Promise<TagRow | undefined> {
    const [row] = await this.db.select().from(tag).where(eq(tag.id, id)); return row;
  }
  async listInstancesForItem(component: string, itemtype: string, itemid: number): Promise<TagInstanceRow[]> {
    return this.db.select().from(tagInstance)
      .where(and(eq(tagInstance.component, component), eq(tagInstance.itemtype, itemtype), eq(tagInstance.itemid, itemid)))
      .orderBy(asc(tagInstance.ordering));
  }
  async listInstancesForTag(tagid: number): Promise<TagInstanceRow[]> {
    return this.db.select().from(tagInstance).where(eq(tagInstance.tagid, tagid));
  }
  async insertInstance(v: typeof tagInstance.$inferInsert): Promise<TagInstanceRow> {
    const [row] = await this.db.insert(tagInstance).values(v)
      .onConflictDoNothing({ target: [tagInstance.tagid, tagInstance.component, tagInstance.itemtype, tagInstance.itemid, tagInstance.contextid, tagInstance.tiuserid] })
      .returning();
    if (row) return row;
    const [existing] = await this.db.select().from(tagInstance).where(and(
      eq(tagInstance.tagid, v.tagid), eq(tagInstance.component, v.component), eq(tagInstance.itemtype, v.itemtype),
      eq(tagInstance.itemid, v.itemid), eq(tagInstance.contextid, v.contextid), eq(tagInstance.tiuserid, v.tiuserid ?? 0),
    ));
    return existing!;
  }
  async deleteInstancesForItem(component: string, itemtype: string, itemid: number, contextid: number): Promise<void> {
    await this.db.delete(tagInstance).where(and(
      eq(tagInstance.component, component), eq(tagInstance.itemtype, itemtype),
      eq(tagInstance.itemid, itemid), eq(tagInstance.contextid, contextid),
    ));
  }
  async upsertCorrelation(tagid: number, correlatedtags: string): Promise<void> {
    await this.db.insert(tagCorrelation).values({ tagid, correlatedtags })
      .onConflictDoUpdate({ target: tagCorrelation.tagid, set: { correlatedtags } });
  }
  async getCorrelation(tagid: number) {
    const [row] = await this.db.select().from(tagCorrelation).where(eq(tagCorrelation.tagid, tagid));
    return row;
  }

  // comments
  async insertComment(v: typeof comments.$inferInsert): Promise<CommentRow> {
    const [row] = await this.db.insert(comments).values(v).returning(); return row!;
  }
  async getComment(id: number): Promise<CommentRow | undefined> {
    const [row] = await this.db.select().from(comments).where(eq(comments.id, id)); return row;
  }
  async listComments(component: string, commentarea: string, itemid: number, contextid: number): Promise<CommentRow[]> {
    return this.db.select().from(comments).where(and(
      eq(comments.component, component), eq(comments.commentarea, commentarea),
      eq(comments.itemid, itemid), eq(comments.contextid, contextid), isNull(comments.timedeleted),
    )).orderBy(desc(comments.id));
  }
  async softDeleteComment(id: number): Promise<void> {
    await this.db.update(comments).set({ timedeleted: new Date() }).where(eq(comments.id, id));
  }

  // ratings
  async upsertRating(v: typeof rating.$inferInsert): Promise<RatingRow> {
    const [row] = await this.db.insert(rating).values(v).onConflictDoUpdate({
      target: [rating.contextid, rating.component, rating.ratingarea, rating.itemid, rating.userid],
      set: { rating: v.rating, scaleid: v.scaleid, timemodified: new Date() },
    }).returning();
    return row!;
  }
  async listRatings(component: string, ratingarea: string, itemid: number, contextid: number): Promise<RatingRow[]> {
    return this.db.select().from(rating).where(and(
      eq(rating.component, component), eq(rating.ratingarea, ratingarea),
      eq(rating.itemid, itemid), eq(rating.contextid, contextid),
    )).orderBy(asc(rating.id));
  }

  // blog
  async insertPost(v: typeof blogPosts.$inferInsert): Promise<BlogPostRow> {
    const [row] = await this.db.insert(blogPosts).values(v).returning(); return row!;
  }
  async getPost(id: number): Promise<BlogPostRow | undefined> {
    const [row] = await this.db.select().from(blogPosts).where(eq(blogPosts.id, id)); return row;
  }
  async listPosts(): Promise<BlogPostRow[]> {
    return this.db.select().from(blogPosts).orderBy(desc(blogPosts.id));
  }
  async listPostsByUser(userid: number): Promise<BlogPostRow[]> {
    return this.db.select().from(blogPosts).where(eq(blogPosts.userid, userid)).orderBy(desc(blogPosts.id));
  }
  async updatePost(id: number, patch: Partial<BlogPostRow>): Promise<void> {
    await this.db.update(blogPosts).set({ ...patch, lastmodified: new Date() }).where(eq(blogPosts.id, id));
  }
  async deletePost(id: number): Promise<void> {
    await this.db.delete(blogPosts).where(eq(blogPosts.id, id));
  }
  async addAssociation(v: typeof blogAssociation.$inferInsert): Promise<void> {
    await this.db.insert(blogAssociation).values(v).onConflictDoNothing();
  }
  async listAssociations(blogid: number) {
    return this.db.select().from(blogAssociation).where(eq(blogAssociation.blogid, blogid));
  }
  async listAssociationsForTarget(assoctype: string, associd: number) {
    return this.db.select().from(blogAssociation)
      .where(and(eq(blogAssociation.assoctype, assoctype), eq(blogAssociation.associd, associd)));
  }

  // notes
  async insertNote(v: typeof notes.$inferInsert): Promise<NoteRow> {
    const [row] = await this.db.insert(notes).values(v).returning(); return row!;
  }
  async getNote(id: number): Promise<NoteRow | undefined> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id)); return row;
  }
  async listNotesAbout(userid: number): Promise<NoteRow[]> {
    return this.db.select().from(notes).where(eq(notes.userid, userid)).orderBy(desc(notes.id));
  }
  async deleteNote(id: number): Promise<void> {
    await this.db.delete(notes).where(eq(notes.id, id));
  }
}
