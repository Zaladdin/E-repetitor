import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiRequest, SessionGuard } from './common';
import { ConnectionPageDto } from './connections.dto';
import { EmptyDto, TokenDto } from './dto';
import { InvitationsService } from './invitations';
import { ActivateInvitationDto, InvitationActivationResult, InvitationPreview, TemporaryStudentDto, TemporaryStudentMutation, TemporaryStudentPage } from './invitations.dto';

@ApiTags('Temporary students') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('temporary-students')
export class TemporaryStudentsController {
  constructor(private readonly invitations: InvitationsService) {}
  @Get() @ApiOkResponse({ type: TemporaryStudentPage })
  @ApiOperation({ summary: 'Own teacher drafts, supplied contact data and current invitation delivery state. No account lookup by email.' })
  list(@Req() req: ApiRequest, @Query() query: ConnectionPageDto) { return this.invitations.list(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: TemporaryStudentMutation })
  async create(@Req() req: ApiRequest, @Body() dto: TemporaryStudentDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.invitations.create(req, dto);
    res.setHeader('Location', '/api/v1/temporary-students'); return result;
  }
  @Post(':id/resend') @HttpCode(200) @ApiOkResponse({ type: TemporaryStudentMutation })
  @ApiOperation({ summary: 'Rotate a pending or expired invitation. A 60-second cooldown prevents repeated concurrent rotation.' })
  resend(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: EmptyDto) {
    void dto; return this.invitations.resend(req, id);
  }
  @Post(':id/revoke') @HttpCode(200) @ApiOkResponse({ type: TemporaryStudentMutation })
  revoke(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: EmptyDto) {
    void dto; return this.invitations.revoke(req, id);
  }
}
@ApiTags('Invitations') @Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}
  @Post('preview') @HttpCode(200) @ApiOkResponse({ type: InvitationPreview })
  @ApiOperation({ summary: 'Public token preview exposes only teacher, subject and expiry. Token belongs in request body, never query/path.' })
  preview(@Body() dto: TokenDto) { return this.invitations.preview(dto.token); }
  @Post('activate') @HttpCode(200) @ApiOkResponse({ type: InvitationActivationResult })
  @ApiOperation({ summary: 'One-time new student activation and explicit enrollment consent. Existing emails are never merged or modified.' })
  activate(@Body() dto: ActivateInvitationDto) { return this.invitations.activate(dto); }
}
