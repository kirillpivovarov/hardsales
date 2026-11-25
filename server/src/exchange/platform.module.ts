import { Body, Controller, Get, Global, HttpCode, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../auth/mail.service';
import { object } from '../market/market.inputs';
import { ExchangeActions } from './actions';
import { ExchangeJobs } from './jobs';
import { ExchangeNotifications } from './notifications';
import { PlatformSettings } from './platform-settings';

@Controller()
class PlatformController {
  constructor(private readonly auth: AuthService, private readonly settings: PlatformSettings,
    private readonly jobs: ExchangeJobs, private readonly actions: ExchangeActions,
    private readonly notifications: ExchangeNotifications) {}

  @Get('platform/features')
  async features() {
    return Object.fromEntries((await this.settings.all(true)).map(row => [row.key, row.value]));
  }

  @Get('admin/settings')
  async settingsList(@Req() request: Request) {
    await this.auth.admin(request);
    return this.settings.all();
  }

  @Put('admin/settings/:key')
  async saveSetting(@Req() request: Request, @Param('key') key: string, @Body() body: unknown) {
    return this.settings.put(await this.auth.admin(request), key, object(body).value);
  }

  @Get('admin/jobs')
  async listJobs(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request);
    return this.jobs.history(query);
  }

  @Get('notifications')
  async listNotifications(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.notifications.list((await this.auth.require(request)).id, query);
  }

  @Patch('notifications/:id/read')
  async read(@Req() request: Request, @Param('id') id: string) {
    return this.notifications.mark((await this.auth.require(request)).id, id);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  async readAll(@Req() request: Request) {
    return this.notifications.mark((await this.auth.require(request)).id);
  }

  @Get('actions/:token')
  describe(@Req() request: Request, @Param('token') token: string) {
    return this.actions.open(token, request.ip ?? 'unknown');
  }

  @Post('actions/:token')
  @HttpCode(200)
  act(@Req() request: Request, @Param('token') token: string, @Body() body: unknown) {
    return this.actions.open(token, request.ip ?? 'unknown', { body });
  }
}

const services = [MailService, PlatformSettings, ExchangeActions, ExchangeJobs, ExchangeNotifications];
@Global()
@Module({ controllers: [PlatformController], providers: services, exports: services })
export class PlatformModule {}
