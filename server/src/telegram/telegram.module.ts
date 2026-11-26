import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Module, Param, Post, Req, Res } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { isStaffRole } from '../auth/auth.types';
import { ActualityModule } from '../exchange/actuality.module';
import { object, str, uuid } from '../market/market.inputs';
import { TelegramApi } from './telegram-api';
import { telegramMode } from './telegram-config';
import { TelegramLinks } from './telegram-links';
import { TelegramRuntime } from './telegram-runtime';
import { TelegramSender } from './telegram-sender';
import { TelegramUpdates } from './telegram-updates';

@Controller()
class TelegramController {
  constructor(private readonly auth: AuthService, private readonly links: TelegramLinks,
    private readonly runtime: TelegramRuntime, private readonly updates: TelegramUpdates) {}

  private async member(request: Request) {
    const user = await this.auth.require(request);
    if (isStaffRole(user.role)) throw new ForbiddenException('Привязка Telegram доступна участникам');
    return user.id;
  }

  @Get('me/telegram')
  async getProfile(@Req() request: Request) {
    return this.links.state(await this.member(request));
  }

  @Post('me/telegram/link')
  @HttpCode(200)
  async issueLink(@Req() request: Request) {
    return this.links.issue(await this.member(request));
  }

  @Delete('me/telegram')
  async unlink(@Req() request: Request) {
    return this.links.unlink(await this.member(request));
  }

  @Post('telegram/webhook')
  async webhook(@Req() request: Request, @Body() body: unknown, @Res() response: Response) {
    const given = Buffer.from(request.get('X-Telegram-Bot-Api-Secret-Token') ?? '');
    const secret = Buffer.from(process.env.TELEGRAM_WEBHOOK_SECRET ?? '');
    if (telegramMode() !== 'webhook' || !secret.length || given.length !== secret.length || !timingSafeEqual(given, secret)) {
      response.status(401).end();
      return;
    }
    await this.updates.receive(body);
    response.status(200).end();
  }

  @Get('admin/telegram')
  async getStatus(@Req() request: Request) {
    await this.auth.admin(request);
    return this.runtime.status();
  }

  @Get('admin/telegram/users/:id')
  async userState(@Req() request: Request, @Param('id') id: string) {
    await this.auth.admin(request);
    return this.links.state(uuid(id));
  }

  @Post('admin/telegram/users/:id/unlink')
  @HttpCode(200)
  async override(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const admin = await this.auth.admin(request);
    return this.links.unlink(uuid(id), admin, str(object(body).reason, 'Причина', 3, 500));
  }
}

@Module({ imports: [ActualityModule], controllers: [TelegramController],
  providers: [TelegramApi, TelegramLinks, TelegramRuntime, TelegramSender, TelegramUpdates] })
export class TelegramModule {}
