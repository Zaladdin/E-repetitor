import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiRequest, SessionGuard } from './common';
import { OverviewQueryDto, OverviewView } from './overview.dto';
import { OverviewService } from './overview';

@ApiTags('Account overview') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('overview')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}
  @Get() @ApiOkResponse({ type: OverviewView })
  @ApiOperation({ summary: 'Read one role-scoped snapshot of lessons, published results and manual payment marks. Does not change attempts or financial data.' })
  get(@Req() req: ApiRequest, @Query() query: OverviewQueryDto) { return this.overview.get(req, query); }
}
