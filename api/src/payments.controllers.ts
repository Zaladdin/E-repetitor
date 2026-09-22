import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiRequest, SessionGuard } from './common';
import { ConnectionPageDto } from './connections.dto';
import { PaymentsService } from './payments';
import { CancelPaymentDto, CreatePaymentRecordDto, MarkPaymentDto, PaymentHistoryPage, PaymentQueryDto, PaymentRecordPage, PaymentRecordView } from './payments.dto';

@ApiTags('Manual payment records') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('payment-records')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Get() @ApiOkResponse({ type: PaymentRecordPage })
  @ApiOperation({ summary: 'Read scoped manual payment statuses. Family views exclude private history and reasons.' })
  list(@Req() req: ApiRequest, @Query() query: PaymentQueryDto) { return this.payments.list(req.userId!, query); }
  @Post() @ApiCreatedResponse({ type: PaymentRecordView })
  @ApiOperation({ summary: 'Teacher creates an unpaid journal entry in an active enrollment. No money is transferred.' })
  async create(@Req() req: ApiRequest, @Body() dto: CreatePaymentRecordDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.payments.create(req, dto); res.setHeader('Location', `/api/v1/payment-records/${result.id}`); return result;
  }
  @Patch(':id') @ApiOkResponse({ type: PaymentRecordView })
  @ApiOperation({ summary: 'Teacher sets desired paid status with version CAS. Removing a paid mark requires a private correction reason.' })
  mark(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: MarkPaymentDto) { return this.payments.mark(req, id, dto); }
  @Post(':id/cancel') @HttpCode(200) @ApiOkResponse({ type: PaymentRecordView })
  @ApiOperation({ summary: 'Teacher cancels an unpaid entry with a reason and current version. Does not issue a refund.' })
  cancel(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: CancelPaymentDto) { return this.payments.cancel(req, id, dto); }
  @Get(':id/history') @ApiOkResponse({ type: PaymentHistoryPage })
  @ApiOperation({ summary: 'Owning teacher only: typed manual status history and private correction reasons.' })
  history(@Req() req: ApiRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query() query: ConnectionPageDto) { return this.payments.history(req.userId!, id, query); }
}
