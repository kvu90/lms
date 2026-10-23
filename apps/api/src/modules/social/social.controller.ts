import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BlogService } from './blog.service';
import { CommentsService } from './comments.service';
import { NotesService } from './notes.service';
import { RatingsService } from './ratings.service';
import { TagsService } from './tags.service';
import { addCommentSchema, addItemTagSchema, associateBlogPostSchema, createBlogPostSchema, createNoteSchema, rateItemSchema, setItemTagsSchema, updateBlogPostSchema, type AddCommentDto, type AddItemTagDto, type AssociatePostDto, type CreateNoteDto, type CreatePostDto, type RateDto, type SetItemTagsDto, type UpdatePostDto } from './dto/social.dto';

@ApiTags('tags')
@Controller({ path: 'tags', version: '1' })
/**
 * API thẻ: collection, area, gắn/gỡ tag cho item và tag liên quan.
 */
export class TagsController {
  constructor(private readonly tags: TagsService) {}
  @Get('areas')
  async areas() { return this.tags.listAreas(); }
  @Get('collections')
  async collections() { return this.tags.listCollections(); }
  @Post('items')
  async set(@Body({ schema: setItemTagsSchema }) dto: SetItemTagsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.tags.setItemTags(actor.id, dto);
  }
  @Post('items/add')
  async add(@Body({ schema: addItemTagSchema }) dto: AddItemTagDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.tags.addItemTag(actor.id, dto);
  }
  @Get('items')
  async list(@Query('component') component: string, @Query('itemType') itemType: string, @Query('itemId') itemId: string) {
    return this.tags.listItemTags(component, itemType, itemId);
  }
  @Get(':tagId/correlated')
  async correlated(@Param('tagId', { schema: uuidIdSchema }) tagId: string) {
    return this.tags.getCorrelated(tagId);
  }
}

@ApiTags('comments')
@Controller({ path: 'comments', version: '1' })
/**
 * API bình luận theo item/context.
 */
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}
  @Post()
  async add(@Body({ schema: addCommentSchema }) dto: AddCommentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.comments.addComment(actor.id, dto);
  }
  @Get()
  async list(@Query('contextId') contextId: string, @Query('component') component: string,
    @Query('commentArea') commentArea: string, @Query('itemId') itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.comments.listComments(actor.id, { contextId, component, commentArea, itemId });
  }
  @Delete(':id')
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.comments.deleteComment(actor.id, id);
  }
}

@ApiTags('ratings')
@Controller({ path: 'ratings', version: '1' })
/**
 * API đánh giá sao: chấm, tổng hợp và danh sách.
 */
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}
  @Post()
  async rate(@Body({ schema: rateItemSchema }) dto: RateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.ratings.rate(actor.id, dto);
  }
  @Get('aggregate')
  async aggregate(@Query('contextId') contextId: string, @Query('component') component: string,
    @Query('ratingArea') ratingArea: string, @Query('itemId') itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.ratings.aggregate(actor.id, { contextId, component, ratingArea, itemId });
  }
  @Get()
  async list(@Query('contextId') contextId: string, @Query('component') component: string,
    @Query('ratingArea') ratingArea: string, @Query('itemId') itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.ratings.listRatings(actor.id, { contextId, component, ratingArea, itemId });
  }
}

@ApiTags('blog')
@Controller({ path: 'blog', version: '1' })
/**
 * API blog: bài viết và liên kết với khoá học/module.
 */
export class BlogController {
  constructor(private readonly blog: BlogService) {}
  @Post('posts')
  async create(@Body({ schema: createBlogPostSchema }) dto: CreatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.createPost(actor.id, dto);
  }
  @Get('posts')
  async list(@Query('userId') userId: string | undefined, @Query('courseId') courseId: string | undefined,
    @Query('cmid') cmid: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.listPosts(actor.id, {
      userId: userId || undefined,
      courseId: courseId || undefined,
      cmid: cmid || undefined,
    });
  }
  @Get('posts/:id')
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    const post = await this.blog.getPost(id);
    return { ...post, visibleToMe: await this.blog.canView(post, actor.id) };
  }
  @Patch('posts/:id')
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateBlogPostSchema }) dto: UpdatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.updatePost(actor.id, id, dto);
  }
  @Delete('posts/:id')
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.deletePost(actor.id, id);
  }
  @Post('posts/:id/associations')
  async associate(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: associateBlogPostSchema }) dto: AssociatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.associate(actor.id, id, dto);
  }
}

@ApiTags('notes')
@Controller({ path: 'notes', version: '1' })
/**
 * API ghi chú khoá học về học viên.
 */
export class NotesController {
  constructor(private readonly notes: NotesService) {}
  @Post()
  async create(@Body({ schema: createNoteSchema }) dto: CreateNoteDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.createNote(actor.id, dto);
  }
  @Get('user/:userId')
  async listAbout(@Param('userId', { schema: uuidIdSchema }) userId: string, @Query('courseId') courseId: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.listNotesAbout(actor.id, userId, courseId || undefined);
  }
  @Get(':id')
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.getNote(actor.id, id);
  }
  @Delete(':id')
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.deleteNote(actor.id, id);
  }
}
