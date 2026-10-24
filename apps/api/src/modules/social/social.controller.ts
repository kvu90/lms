import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BlogMigrationService } from './blog-migration.service';
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
  async list(@Query('component') component: string, @Query('itemType') itemType: string, @Query('itemId') itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.tags.listItemTags(component, itemType, itemId, actor.id);
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
  constructor(
    private readonly blog: BlogService,
    private readonly migration: BlogMigrationService,
  ) {}
  @Post('posts')
  async create(@Body({ schema: createBlogPostSchema }) dto: CreatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.createPost(actor.id, dto);
  }
  @Get('feed')
  async feed(@Query('spaceType') spaceType: string | undefined, @Query('spaceId') spaceId: string | undefined,
    @Query('authorId') authorId: string | undefined, @Query('kind') kind: string | undefined,
    @Query('status') status: string | undefined, @Query('tag') tag: string | undefined,
    @Query('cursor') cursor: string | undefined, @Query('limit') limit: string | undefined,
    @CurrentUser() actor: AuthenticatedUser) {
    // Feed theo space (BL1): phân trang con trỏ + lọc kind/tag/status;
    // audience lọc theo viewer ở service.
    return this.blog.feed(actor.id, {
      spaceType: spaceType || undefined,
      spaceId: spaceId || undefined,
      authorId: authorId || undefined,
      kind: kind || undefined,
      status: status || undefined,
      tag: tag || undefined,
      cursor: cursor || undefined,
      limit: limit ? Number.parseInt(limit, 10) || undefined : undefined,
    });
  }
  @Post('migrations/space-model')
  async runSpaceMigration(@CurrentUser() actor: AuthenticatedUser) {
    // Backfill di trú dữ liệu cũ sang mô hình space (BL1) — site admin.
    return this.migration.runAsAdmin(actor.id);
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
    // Cổng audience (issue #48): không có quyền xem → 404, không trả nội
    // dung kèm cờ như trước. Viewer hợp lệ luôn có visibleToMe = true.
    const post = await this.blog.getPostForViewer(id, actor.id);
    return { ...post, visibleToMe: true };
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
