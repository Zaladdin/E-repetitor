import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiRequest, SessionGuard } from './common';
import { ConnectionPageDto } from './connections.dto';
import { PackagesService } from './packages';
import { ChargePackageDto, ClosePackageDto, CreatePackageDto, PackageHistoryPage, PackageLessonPage, PackagePage, PackageQueryDto, PackageRoleQueryDto, PackageView, ReversePackageDto } from './packages.dto';

@ApiTags('Lesson packages') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('packages')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}
  @Get() @ApiOkResponse({ type: PackagePage })
  @ApiOperation({ summary: 'Role-scoped packages with ledger balances and the existing manual payment status.' })
  list(@Req() req: ApiRequest, @Query() query: PackageQueryDto) { return this.packages.list(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: PackageView })
  @ApiOperation({ summary: 'Teacher creates a package and one unpaid payment record atomically. No online payment.' })
  async create(@Req() req: ApiRequest, @Body() dto: CreatePackageDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.packages.create(req, dto); res.setHeader('Location', `/api/v1/packages/${result.id}`); return result;
  }
  @Get(':id/lessons') @ApiOkResponse({ type: PackageLessonPage })
  @ApiOperation({ summary: 'Owning teacher only: ended attended or absent lessons with no unreversed package charge.' })
  lessons(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query() query: ConnectionPageDto) { return this.packages.lessons(req.userId!, id, query); }
  @Post(':id/charges') @HttpCode(200) @ApiOkResponse({ type: PackageView })
  @ApiOperation({ summary: 'Teacher explicitly charges one lesson. Requires package and lesson versions; absent lessons require a reason.' })
  charge(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ChargePackageDto) { return this.packages.charge(req, id, dto); }
  @Post(':id/reversals') @HttpCode(200) @ApiOkResponse({ type: PackageView })
  @ApiOperation({ summary: 'Teacher returns one lesson by referencing its charge; preserves history including closed packages.' })
  reverse(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ReversePackageDto) { return this.packages.reverse(req, id, dto); }
  @Post(':id/close') @HttpCode(200) @ApiOkResponse({ type: PackageView })
  @ApiOperation({ summary: 'Teacher closes a package with a reason, preserving all remaining lessons and ledger entries.' })
  close(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: ClosePackageDto) { return this.packages.close(req, id, dto); }
  @Get(':id/history') @ApiOkResponse({ type: PackageHistoryPage })
  @ApiOperation({ summary: 'Scoped package movements. Teacher names and private reasons are excluded from family history.' })
  history(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query() query: PackageRoleQueryDto) { return this.packages.history(req.userId!, id, query); }
}
