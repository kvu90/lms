import {
  addCommentSchema,
  addItemTagSchema,
  associateBlogPostSchema,
  createBlogPostSchema,
  createNoteSchema,
  rateItemSchema,
  setItemTagsSchema,
  updateBlogPostSchema,
  type AddComment,
  type AddItemTag,
  type AssociateBlogPost,
  type CreateBlogPost,
  type CreateNote,
  type RateItem,
  type SetItemTags,
  type UpdateBlogPost,
} from '@lms/contracts';

/**
 * Validation của Social (tags/comments/ratings/blog/notes) dùng Zod qua
 * Standard Schema — schema nền ở `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  addCommentSchema,
  addItemTagSchema,
  associateBlogPostSchema,
  createBlogPostSchema,
  createNoteSchema,
  rateItemSchema,
  setItemTagsSchema,
  updateBlogPostSchema,
};
export type SetItemTagsDto = SetItemTags;
export type AddItemTagDto = AddItemTag;
export type AddCommentDto = AddComment;
export type RateDto = RateItem;
export type CreatePostDto = CreateBlogPost;
export type UpdatePostDto = UpdateBlogPost;
export type AssociatePostDto = AssociateBlogPost;
export type CreateNoteDto = CreateNote;
