import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiRequest, SessionGuard } from './common';
import { GroupsService } from './groups';
import { ArchiveGroupDto, CreateGroupDto, GroupCandidatesPage, GroupCandidatesQueryDto, GroupSchedulePage, GroupScheduleQueryDto, GroupsPage, GroupsQueryDto, GroupView, UpdateGroupDto } from './groups.dto';

@ApiTags('Groups') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}
  @Get() @ApiOkResponse({ type: GroupsPage })
  list(@Req() req: ApiRequest, @Query() query: GroupsQueryDto) { return this.groups.list(req.userId!, query); }
  @Get('candidates') @ApiOkResponse({ type: GroupCandidatesPage })
  candidates(@Req() req: ApiRequest, @Query() query: GroupCandidatesQueryDto) { return this.groups.candidates(req.userId!, query); }
  @Get('schedule') @ApiOkResponse({ type: GroupSchedulePage })
  schedule(@Req() req: ApiRequest, @Query() query: GroupScheduleQueryDto) { return this.groups.schedule(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: GroupView })
  create(@Req() req: ApiRequest, @Body() dto: CreateGroupDto) { return this.groups.create(req, dto); }
  @Patch(':id') @ApiOkResponse({ type: GroupView })
  update(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: UpdateGroupDto) {
    return this.groups.update(req, id, dto);
  }
  @Post(':id/archive') @HttpCode(200) @ApiOkResponse({ type: GroupView })
  archive(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ArchiveGroupDto) {
    return this.groups.archive(req, id, dto);
  }
}
