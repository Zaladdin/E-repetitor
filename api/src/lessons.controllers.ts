import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiRequest, SessionGuard } from './common';
import { ConnectionPageDto } from './connections.dto';
import { LessonsService } from './lessons';
import { AttendanceDto, CancelLessonDto, CreateLessonDto, LessonHistoryPage, LessonMutationView, LessonPage, LessonQueryDto, RescheduleLessonDto } from './lessons.dto';

@ApiTags('Lessons') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('lessons')
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}
  @Get() @ApiOkResponse({ type: LessonPage })
  @ApiOperation({ summary: 'List overlapping lessons within a required <=93-day range and an explicit role. Teacher-only private notes and attendance comments.' })
  list(@Req() req: ApiRequest, @Query() query: LessonQueryDto) { return this.lessons.list(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: LessonMutationView })
  @ApiOperation({ summary: 'Teacher books an active enrollment. Stable requestId makes retries safe; overlapping teacher lessons are rejected.' })
  async create(@Req() req: ApiRequest, @Body() dto: CreateLessonDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.lessons.create(req, dto); res.setHeader('Location', `/api/v1/lessons/${result.id}/history`); return result;
  }
  @Post(':id/reschedule') @HttpCode(200) @ApiOkResponse({ type: LessonMutationView })
  @ApiOperation({ summary: 'Teacher replaces a scheduled lesson with a new lesson, retaining original time and audited history. Requires current version.' })
  reschedule(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: RescheduleLessonDto) {
    return this.lessons.reschedule(req, id, dto);
  }
  @Patch(':id') @ApiOkResponse({ type: LessonMutationView })
  @ApiOperation({ summary: 'Teacher records a student or teacher cancellation with reason and current version. No deletion or automatic charges.' })
  cancel(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: CancelLessonDto) {
    return this.lessons.cancel(req, id, dto);
  }
  @Post(':id/attendance') @HttpCode(200) @ApiOkResponse({ type: LessonMutationView })
  @ApiOperation({ summary: 'Teacher marks attendance only after lesson end. Corrections require reason and current version; history is retained.' })
  attendance(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: AttendanceDto) {
    return this.lessons.attendance(req, id, dto);
  }
  @Get(':id/history') @ApiOkResponse({ type: LessonHistoryPage })
  @ApiOperation({ summary: 'Owning teacher only: paginated typed history, with no raw internal snapshots.' })
  history(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query() query: ConnectionPageDto) {
    return this.lessons.history(req.userId!, id, query);
  }
}
