import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiRequest, SessionGuard } from './common';
import { EmptyDto } from './dto';
import { ConnectionsService } from './connections';
import {
  ConnectionMutationView, ConnectionPageDto, EnrollmentPage, EnrollmentQueryDto, EnrollmentRequestDto, EnrollmentStatusDto,
  ParentChildrenPage, ParentConnectionPage, ParentConnectionQueryDto, StudentIdDto,
} from './connections.dto';

@ApiTags('Enrollments') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly connections: ConnectionsService) {}
  @Get() @ApiOkResponse({ type: EnrollmentPage })
  @ApiOperation({ summary: 'List only the authenticated teacher or student context. Pending requests expose no student name.' })
  list(@Req() req: ApiRequest, @Query() query: EnrollmentQueryDto) { return this.connections.enrollments(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: ConnectionMutationView })
  @ApiOperation({ summary: 'Teacher requests enrollment by public Student ID and own subject. Pending retries return the same ID.' })
  async request(@Req() req: ApiRequest, @Body() dto: EnrollmentRequestDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.connections.requestEnrollment(req, dto);
    res.setHeader('Location', `/api/v1/enrollments?role=teacher`); return result;
  }
  @Post(':id/accept') @HttpCode(200) @ApiOkResponse({ type: ConnectionMutationView })
  @ApiOperation({ summary: 'Only the owning student can accept a pending, unexpired request.' })
  accept(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() _dto: EmptyDto) {
    void _dto;
    return this.connections.decideEnrollment(req, id, true);
  }
  @Post(':id/reject') @HttpCode(200) @ApiOkResponse({ type: ConnectionMutationView })
  reject(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() _dto: EmptyDto) {
    void _dto;
    return this.connections.decideEnrollment(req, id, false);
  }
  @Patch(':id') @ApiOkResponse({ type: ConnectionMutationView })
  @ApiOperation({ summary: 'Owning teacher may pause, resume, complete or cancel an accepted enrollment.' })
  update(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: EnrollmentStatusDto) {
    return this.connections.updateEnrollment(req, id, dto);
  }
}

@ApiTags('Parent connections') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('parent-connections')
export class ParentConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}
  @Get() @ApiOkResponse({ type: ParentConnectionPage })
  list(@Req() req: ApiRequest, @Query() query: ParentConnectionQueryDto) { return this.connections.parentConnections(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: ConnectionMutationView })
  @ApiOperation({ summary: 'Parent requests a connection by public Student ID. No child data until student approval.' })
  async request(@Req() req: ApiRequest, @Body() dto: StudentIdDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.connections.requestParentConnection(req, dto.publicId);
    res.setHeader('Location', '/api/v1/parent-connections?role=parent'); return result;
  }
  @Post(':id/approve') @HttpCode(200) @ApiOkResponse({ type: ConnectionMutationView })
  approve(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() _dto: EmptyDto) {
    void _dto;
    return this.connections.decideParentConnection(req, id, true);
  }
  @Post(':id/reject') @HttpCode(200) @ApiOkResponse({ type: ConnectionMutationView })
  reject(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() _dto: EmptyDto) {
    void _dto;
    return this.connections.decideParentConnection(req, id, false);
  }
  @Post(':id/revoke') @HttpCode(200) @ApiOkResponse({ type: ConnectionMutationView })
  @ApiOperation({ summary: 'Owning student or parent revokes the active connection. Access stops immediately.' })
  revoke(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() _dto: EmptyDto) {
    void _dto;
    return this.connections.revokeParentConnection(req, id);
  }
}

@ApiTags('Parent children') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('parent-children')
export class ParentChildrenController {
  constructor(private readonly connections: ConnectionsService) {}
  @Get() @ApiOkResponse({ type: ParentChildrenPage })
  @ApiOperation({ summary: 'Approved children and all their active enrollments across tutors. No private teacher notes.' })
  list(@Req() req: ApiRequest, @Query() query: ConnectionPageDto) { return this.connections.parentChildren(req.userId!, query); }
}
