import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiRequest, SessionGuard } from './common';
import { NotificationPage, NotificationPreferenceDto, NotificationPreferenceList, NotificationPreferenceView, NotificationQueryDto, NotificationReadView } from './notifications.dto';
import { NotificationsService } from './notifications';

@ApiTags('Notifications') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get() @ApiOkResponse({ type: NotificationPage }) @ApiOperation({ summary: 'Account-wide feed with current resource and parental consent authorization. Unread total is independent of pagination.' })
  list(@Req() req: ApiRequest, @Query() query: NotificationQueryDto) { return this.notifications.list(req.userId!, query); }
  @Post(':id/read') @HttpCode(200) @ApiOkResponse({ type: NotificationReadView })
  read(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) { return this.notifications.read(req, id); }
}
@ApiTags('Notification preferences') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly notifications: NotificationsService) {}
  @Get() @ApiOkResponse({ type: NotificationPreferenceList })
  get(@Req() req: ApiRequest) { return this.notifications.preferences(req.userId!); }
  @Patch(':type') @ApiOkResponse({ type: NotificationPreferenceView }) @ApiOperation({ summary: 'Change future channels with version compare-and-swap. Existing in-app history is retained; queued email checks current preferences.' })
  patch(@Req() req: ApiRequest, @Param('type') type: string, @Body() dto: NotificationPreferenceDto) { return this.notifications.preference(req, type, dto); }
}
