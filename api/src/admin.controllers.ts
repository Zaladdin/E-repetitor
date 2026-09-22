import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiRequest, SessionGuard } from './common';
import { AdminService } from './admin';
import { AdminAuditPage, AdminAuditQueryDto, AdminOverviewView, AdminStatusDto, AdminUserDetail, AdminUsersPage, AdminUsersQueryDto, AdminUserView } from './admin.dto';
import { EmptyDto } from './dto';

@ApiTags('Administration') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}
  @Get('overview') @ApiOkResponse({ type: AdminOverviewView })
  @ApiOperation({ summary: 'Administrator-only aggregate counts. No educational content.' })
  overview(@Req() req: ApiRequest, @Query() query: EmptyDto) { void query; return this.admin.overview(req); }
  @Get('users') @ApiOkResponse({ type: AdminUsersPage })
  users(@Req() req: ApiRequest, @Query() query: AdminUsersQueryDto) { return this.admin.users(req, query); }
  @Get('users/:id') @ApiOkResponse({ type: AdminUserDetail })
  @ApiOperation({ summary: 'Minimal technical metadata. Never returns credentials, tokens or educational content.' })
  user(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query() query: EmptyDto) { void query; return this.admin.user(req, id.toLowerCase()); }
  @Post('users/:id/status') @HttpCode(200) @ApiOkResponse({ type: AdminUserView })
  @ApiOperation({ summary: 'Reason and version required. Suspend/unsuspend or terminal deactivation. Administrator accounts are protected.' })
  status(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: AdminStatusDto) { return this.admin.status(req, id.toLowerCase(), dto); }
  @Get('audit') @ApiOkResponse({ type: AdminAuditPage })
  @ApiOperation({ summary: 'Critical action metadata and administrative reasons; no secret or educational payload.' })
  audit(@Req() req: ApiRequest, @Query() query: AdminAuditQueryDto) { return this.admin.audit(req, query); }
}
