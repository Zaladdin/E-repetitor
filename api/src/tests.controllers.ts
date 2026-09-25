import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiRequest, SessionGuard } from './common';
import { ConnectionPageDto } from './connections.dto';
import { TestAssignmentsService } from './tests.assignments';
import { TestAttemptsService } from './tests.attempts';
import { TestsService } from './tests';
import { AssignmentPage, AssignmentQueryDto, AssignmentView, AttemptMutationView, AttemptQueryDto, AttemptVersionDto, AttemptView, CreateAssignmentDto, CreateGroupAssignmentDto, CreateTestDto, CreateTestVariantDto, GroupAssignmentView, ReviewAttemptDto, SaveAnswersDto, StartAttemptDto, TestDetail, TestFamilyPage, TestPage, TestRevisionDto, TestVersion, TestVersionPage, UpdateTestDto } from './tests.dto';

const uuid = () => new ParseUUIDPipe({ version: '4' });
@ApiTags('Tests') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('tests')
export class TestsController {
  constructor(private readonly tests: TestsService) {}
  @Get() @ApiOkResponse({ type: TestPage }) @ApiOperation({ summary: 'Teacher-owned paginated test catalog.' })
  list(@Req() req: ApiRequest, @Query() query: ConnectionPageDto) { return this.tests.list(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: TestDetail }) @ApiOperation({ summary: 'Teacher saves a draft. Stable requestId makes creation retries safe.' })
  create(@Req() req: ApiRequest, @Body() dto: CreateTestDto) { return this.tests.create(req, dto); }
  @Get(':id') @ApiOkResponse({ type: TestDetail })
  get(@Req() req: ApiRequest, @Param('id', uuid()) id: string) { return this.tests.get(req.userId!, id); }
  @Patch(':id') @ApiOkResponse({ type: TestDetail }) @ApiOperation({ summary: 'Edit the current draft with revision CAS; published snapshots remain immutable.' })
  update(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: UpdateTestDto) { return this.tests.update(req, id, dto); }
  @Post(':id/publish') @HttpCode(200) @ApiOkResponse({ type: TestVersion }) @ApiOperation({ summary: 'Freeze a validated version. Repeating the original draft revision returns the same version.' })
  publish(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: TestRevisionDto) { return this.tests.publish(req, id, dto); }
  @Post(':id/archive') @HttpCode(200) @ApiOkResponse({ type: TestDetail })
  archive(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: TestRevisionDto) { return this.tests.archive(req, id, dto); }
  @Get(':id/versions') @ApiOkResponse({ type: TestVersionPage })
  versions(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Query() query: ConnectionPageDto) { return this.tests.versions(req.userId!, id, query); }
  @Get(':id/variants') @ApiOkResponse({ type: TestPage })
  variants(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Query() query: ConnectionPageDto) { return this.tests.variants(req.userId!, id, query); }
  @Post(':id/variants') @ApiCreatedResponse({ type: TestDetail }) @ApiOperation({ summary: 'Clone the selected draft into an independent named variant in the same family. Does not publish.' })
  createVariant(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: CreateTestVariantDto) { return this.tests.createVariant(req, id, dto); }
}
@ApiTags('Tests') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('test-families')
export class TestFamiliesController {
  constructor(private readonly tests: TestsService) {}
  @Get() @ApiOkResponse({ type: TestFamilyPage })
  list(@Req() req: ApiRequest, @Query() query: ConnectionPageDto) { return this.tests.families(req.userId!, query); }
}
@ApiTags('Test assignments') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('test-group-assignments')
export class TestGroupAssignmentsController {
  constructor(private readonly assignments: TestAssignmentsService) {}
  @Post() @ApiCreatedResponse({ type: GroupAssignmentView }) @ApiOperation({ summary: 'Atomically assign one immutable variant version to a snapshot of active group members. Retries retain the original recipients.' })
  create(@Req() req: ApiRequest, @Body() dto: CreateGroupAssignmentDto) { return this.assignments.createGroup(req, dto); }
}
@ApiTags('Tests') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('test-versions')
export class TestVersionsController {
  constructor(private readonly tests: TestsService) {}
  @Get(':id') @ApiOkResponse({ type: TestVersion }) @ApiOperation({ summary: 'Owning teacher only: immutable version including keys.' })
  get(@Req() req: ApiRequest, @Param('id', uuid()) id: string) { return this.tests.version(req.userId!, id); }
}
@ApiTags('Test assignments') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('test-assignments')
export class TestAssignmentsController {
  constructor(private readonly assignments: TestAssignmentsService, private readonly attempts: TestAttemptsService) {}
  @Get() @ApiOkResponse({ type: AssignmentPage }) @ApiOperation({ summary: 'Scoped assignments. Parents see only published attempts of actively connected children. Deadline is a soft due date.' })
  list(@Req() req: ApiRequest, @Query() query: AssignmentQueryDto) { return this.assignments.list(req, query); }
  @Post() @ApiCreatedResponse({ type: AssignmentView })
  create(@Req() req: ApiRequest, @Body() dto: CreateAssignmentDto) { return this.assignments.create(req, dto); }
  @Post(':id/attempts') @ApiCreatedResponse({ type: AttemptMutationView }) @ApiOperation({ summary: 'Owning student starts or resumes one attempt. Abandoned and expired attempts consume limits. Timer uses the database clock.' })
  start(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: StartAttemptDto) { return this.attempts.start(req, id, dto); }
}
@ApiTags('Test attempts') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('attempts')
export class TestAttemptsController {
  constructor(private readonly attempts: TestAttemptsService) {}
  @Get(':id') @ApiOkResponse({ type: AttemptView }) @ApiOperation({ summary: 'Explicit role projection. Keys follow answerPolicy; final student results follow resultPolicy. Parents only see published totals and never answers or keys.' })
  get(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Query() query: AttemptQueryDto) { return this.attempts.get(req, id, query); }
  @Patch(':id/answers') @ApiOkResponse({ type: AttemptMutationView }) @ApiOperation({ summary: 'Replace saved answers with version CAS before timer expiration. No client grades accepted.' })
  save(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: SaveAnswersDto) { return this.attempts.save(req, id, dto); }
  @Post(':id/submit') @HttpCode(200) @ApiOkResponse({ type: AttemptMutationView })
  submit(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: AttemptVersionDto) { return this.attempts.submit(req, id, dto); }
  @Post(':id/abandon') @HttpCode(200) @ApiOkResponse({ type: AttemptMutationView })
  abandon(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: AttemptVersionDto) { return this.attempts.abandon(req, id, dto); }
  @Post(':id/review') @HttpCode(200) @ApiOkResponse({ type: AttemptMutationView }) @ApiOperation({ summary: 'Owning teacher grades every text question; closed scores are recomputed. Audited revisions allowed before publication.' })
  review(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: ReviewAttemptDto) { return this.attempts.review(req, id, dto); }
  @Post(':id/publish-result') @HttpCode(200) @ApiOkResponse({ type: AttemptMutationView })
  publish(@Req() req: ApiRequest, @Param('id', uuid()) id: string, @Body() dto: AttemptVersionDto) { return this.attempts.publish(req, id, dto); }
}
