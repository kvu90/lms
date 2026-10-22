import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { CreateUserDto, ListUsersQueryDto, SetPreferenceDto, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @RequireCapability('moodle/user:create')
  async create(@Body() dto: CreateUserDto) {
    const user = await this.users.createUser(dto);
    return { id: user.id, username: user.username, email: user.email, firstname: user.firstname, lastname: user.lastname };
  }

  @Get()
  @RequireCapability('moodle/user:viewdetails')
  async list(@Query() query: ListUsersQueryDto, @CurrentUser() viewer: AuthenticatedUser) {
    const result = await this.users.listUsers(query.search, query.page ?? 1, query.pageSize ?? 20);
    const views = [];
    for (const u of result.users) views.push(await this.users.getProfileView(u.id, viewer.id));
    return { users: views, total: result.total, page: result.page, pageSize: result.pageSize };
  }

  @Get('me')
  async me(@CurrentUser() viewer: AuthenticatedUser) { return this.users.getProfileView(viewer.id, viewer.id); }

  @Get(':id')
  @RequireCapability('moodle/user:viewdetails', 'param:userId:userctx')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() viewer: AuthenticatedUser) {
    return this.users.getProfileView(id, viewer.id);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.users.assertCanUpdateProfile(actor.id, id);
    const user = await this.users.updateUser(id, dto);
    return this.users.getProfileView(user.id, actor.id);
  }

  @Post(':id/suspend')
  @RequireCapability('moodle/user:update')
  async suspend(@Param('id', ParseIntPipe) id: number) {
    const user = await this.users.setSuspended(id, true);
    return { id: user.id, suspended: user.suspended };
  }
  @Post(':id/unsuspend')
  @RequireCapability('moodle/user:update')
  async unsuspend(@Param('id', ParseIntPipe) id: number) {
    const user = await this.users.setSuspended(id, false);
    return { id: user.id, suspended: user.suspended };
  }
  @Delete(':id')
  @RequireCapability('moodle/user:delete')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const user = await this.users.deleteUser(id);
    return { id: user.id, deleted: user.deleted };
  }

  @Put(':id/preferences')
  async setPreference(@Param('id', ParseIntPipe) id: number, @Body() dto: SetPreferenceDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.users.assertCanUpdateProfile(actor.id, id);
    await this.users.setPreference(id, dto.name, dto.value ?? null);
    return { saved: true };
  }
  @Get(':id/preferences/:name')
  async getPreference(@Param('id', ParseIntPipe) id: number, @Param('name') name: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.users.assertCanUpdateProfile(actor.id, id);
    return { name, value: (await this.users.getPreference(id, name)) ?? null };
  }
}
