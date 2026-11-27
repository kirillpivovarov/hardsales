import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { InvitesService } from './invites.service';
import { OnboardingService } from './onboarding.service';

@Controller()
export class OnboardingController {
  constructor(
    private readonly auth: AuthService,
    private readonly onboarding: OnboardingService,
    private readonly invites: InvitesService,
  ) {}

  @Get('onboarding')
  async get(@Req() request: Request) {
    return this.onboarding.get(await this.auth.participant(request));
  }

  @Put('onboarding')
  async submit(@Req() request: Request, @Body() input: unknown) {
    return { user: await this.onboarding.submit(await this.auth.participant(request), input) };
  }

  @Post('auth/rules/accept')
  @HttpCode(200)
  async accept(@Req() request: Request, @Body() input: unknown) {
    return { user: await this.onboarding.acceptRules(await this.auth.participant(request), input) };
  }

  @Get('admin/invites')
  async inviteList(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request);
    return this.invites.list(query);
  }

  @Post('admin/invites')
  async createInvites(@Req() request: Request, @Body() input: unknown) {
    return this.invites.create(await this.auth.staff(request), input);
  }

  @Patch('admin/invites/:id/revoke')
  async revokeInvite(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.invites.revoke(await this.auth.staff(request), id, input);
  }

  @Get('admin/users/:id/onboarding')
  async answers(@Req() request: Request, @Param('id') id: string) {
    await this.auth.staff(request);
    return this.onboarding.staffAnswers(id);
  }
}
