import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Response } from 'express';
import { AuthService, Credentials } from './auth';
import { AccountsService } from './accounts';
import { CONFIG, Config } from './config';
import { ACCESS_SECONDS, ApiError, ApiRequest, REFRESH_SECONDS, SessionGuard, cookie } from './common';
import { EmailDto, EmptyDto, LoginDto, RegisterDto, ResetDto, RoleDto, SubjectDto, TokenDto } from './dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(CONFIG) private readonly config: Config) {}
  @Post('register') @HttpCode(202)
  @ApiOperation({ summary: 'Register an email account; requires terms/privacy consent. Generic response.' })
  register(@Body() dto: RegisterDto) { return this.auth.register(dto); }
  @Post('login') @HttpCode(200)
  @ApiOperation({ summary: 'Login after email verification; sets HttpOnly cookies.' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto);
    this.setCookies(res, result.credentials);
    return { user: result.user };
  }
  @Post('refresh') @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token. Reuse revokes this session. Serialize refresh calls.' })
  async refresh(@Body() _dto: EmptyDto, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    try { this.setCookies(res, await this.auth.refresh(cookie(req, 'er_refresh'))); }
    catch (error) { this.clearCookies(res); throw error; }
    return { message: 'Сессия обновлена.' };
  }
  @Post('logout') @HttpCode(200)
  async logout(@Body() _dto: EmptyDto, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.logout(req); this.clearCookies(res); return result;
  }
  @Post('logout-all') @HttpCode(200) @UseGuards(SessionGuard) @ApiCookieAuth()
  async logoutAll(@Body() _dto: EmptyDto, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.logoutAll(req); this.clearCookies(res); return result;
  }
  @Post('verify-email') @HttpCode(200)
  verify(@Body() dto: TokenDto) { return this.auth.verifyEmail(dto.token); }
  @Post('resend-verification') @HttpCode(202)
  resend(@Body() dto: EmailDto) { return this.auth.requestMail(dto.email, 'verify'); }
  @Post('forgot-password') @HttpCode(202)
  forgot(@Body() dto: EmailDto) { return this.auth.requestMail(dto.email, 'reset'); }
  @Post('reset-password') @HttpCode(200)
  async reset(@Body() dto: ResetDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.resetPassword(dto); this.clearCookies(res); return result;
  }
  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.config.production, sameSite: 'strict', path: '/api/v1' };
  }
  private setCookies(res: Response, credentials: Credentials) {
    res.cookie('er_access', credentials.access, { ...this.cookieOptions(), maxAge: ACCESS_SECONDS * 1000 });
    res.cookie('er_refresh', credentials.refresh, { ...this.cookieOptions(), maxAge: REFRESH_SECONDS * 1000 });
  }
  private clearCookies(res: Response) {
    res.clearCookie('er_access', this.cookieOptions()); res.clearCookie('er_refresh', this.cookieOptions());
  }
}

@ApiTags('Account') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('me')
export class AccountController {
  constructor(private readonly accounts: AccountsService) {}
  @Get() me(@Req() req: ApiRequest) { return this.accounts.account(req.userId!); }
  @Post('roles') @HttpCode(200)
  @ApiOperation({ summary: 'Add a role to the authenticated account; idempotent. Admin is never self-assigned.' })
  addRole(@Body() dto: RoleDto, @Req() req: ApiRequest) { return this.accounts.addRole(req, dto.role); }
}

@ApiTags('Subjects') @ApiCookieAuth() @UseGuards(SessionGuard) @Controller('subjects')
export class SubjectsController {
  constructor(private readonly accounts: AccountsService) {}
  @Get()
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } })
  @ApiQuery({ name: 'offset', required: false, schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 } })
  list(@Req() req: ApiRequest, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).some(key => !['limit', 'offset'].includes(key))) throw new ApiError(400, 'validation_error', 'Неизвестный параметр списка.');
    const integer = (value: unknown, fallback: number, min: number, max: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        throw new ApiError(400, 'validation_error', 'Некорректные параметры списка.');
      }
      return Number(value);
    };
    return this.accounts.subjects(req.userId!, integer(query.limit, 100, 1, 100), integer(query.offset, 0, 0, 10000));
  }
  @Post()
  create(@Body() dto: SubjectDto, @Req() req: ApiRequest) { return this.accounts.createSubject(req, dto.name); }
}

@Controller('health')
export class HealthController {
  @Get() health() { return { status: 'ok' }; }
}
