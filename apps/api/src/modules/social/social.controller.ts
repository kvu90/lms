import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BlogService } from './blog.service';
import { CommentsService } from './comments.service';
import { NotesService } from './notes.service';
import { RatingsService } from './ratings.service';
import { TagsService } from './tags.service';
import {
  AddCommentDto, AddItemTagDto, AssociatePostDto, CreateNoteDto, CreatePostDto,
  RateDto, SetItemTagsDto, UpdatePostDto,
} from './dto/social.dto';

@ApiTags('tags')
@Controller({ path: 'tags', version: '1' })
export class TagsController {
  constructor(private readonly tags: TagsService) {}
  @Get('areas')
  async areas() { return this.tags.listAreas(); }
  @Get('collections')
  async collections() { return this.tags.listCollections(); }
  @Post('items')
  async set(@Body() dto: SetItemTagsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.tags.setItemTags(actor.id, dto);
  }
  @Post('items/add')
  async add(@Body() dto: AddItemTagDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.tags.addItemTag(actor.id, dto);
  }
  @Get('items')
  async list(@Query('component') component: string, @Query('itemtype') itemtype: string, @Query('itemid') itemid: string) {
    return this.tags.listItemTags(component, itemtype, Number(itemid));
  }
  @Get(':tagId/correlated')
  async correlated(@Param('tagId', ParseIntPipe) tagId: number) {
    return this.tags.getCorrelated(tagId);
  }
}

@ApiTags('comments')
@Controller({ path: 'comments', version: '1' })
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}
  @Post()
  async add(@Body() dto: AddCommentDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.comments.addComment(actor.id, dto);
  }
  @Get()
  async list(@Query('contextid') contextid: string, @Query('component') component: string,
    @Query('commentarea') commentarea: string, @Query('itemid') itemid: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.comments.listComments(actor.id, { contextid: Number(contextid), component, commentarea, itemid: Number(itemid) });
  }
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.comments.deleteComment(actor.id, id);
  }
}

@ApiTags('ratings')
@Controller({ path: 'ratings', version: '1' })
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}
  @Post()
  async rate(@Body() dto: RateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.ratings.rate(actor.id, dto);
  }
  @Get('aggregate')
  async aggregate(@Query('contextid') contextid: string, @Query('component') component: string,
    @Query('ratingarea') ratingarea: string, @Query('itemid') itemid: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.ratings.aggregate(actor.id, { contextid: Number(contextid), component, ratingarea, itemid: Number(itemid) });
  }
  @Get()
  async list(@Query('contextid') contextid: string, @Query('component') component: string,
    @Query('ratingarea') ratingarea: string, @Query('itemid') itemid: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.ratings.listRatings(actor.id, { contextid: Number(contextid), component, ratingarea, itemid: Number(itemid) });
  }
}

@ApiTags('blog')
@Controller({ path: 'blog', version: '1' })
export class BlogController {
  constructor(private readonly blog: BlogService) {}
  @Post('posts')
  async create(@Body() dto: CreatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.createPost(actor.id, dto);
  }
  @Get('posts')
  async list(@Query('userid') userid: string | undefined, @Query('courseid') courseid: string | undefined,
    @Query('cmid') cmid: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.listPosts(actor.id, {
      userid: userid ? Number(userid) : undefined,
      courseid: courseid ? Number(courseid) : undefined,
      cmid: cmid ? Number(cmid) : undefined,
    });
  }
  @Get('posts/:id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    const post = await this.blog.getPost(id);
    return { ...post, visibleToMe: await this.blog.canView(post, actor.id) };
  }
  @Patch('posts/:id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.updatePost(actor.id, id, dto);
  }
  @Delete('posts/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.deletePost(actor.id, id);
  }
  @Post('posts/:id/associations')
  async associate(@Param('id', ParseIntPipe) id: number, @Body() dto: AssociatePostDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.blog.associate(actor.id, id, dto);
  }
}

@ApiTags('notes')
@Controller({ path: 'notes', version: '1' })
export class NotesController {
  constructor(private readonly notes: NotesService) {}
  @Post()
  async create(@Body() dto: CreateNoteDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.createNote(actor.id, dto);
  }
  @Get('user/:userId')
  async listAbout(@Param('userId', ParseIntPipe) userId: number, @Query('courseid') courseid: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.listNotesAbout(actor.id, userId, courseid ? Number(courseid) : undefined);
  }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.getNote(actor.id, id);
  }
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.notes.deleteNote(actor.id, id);
  }
}
