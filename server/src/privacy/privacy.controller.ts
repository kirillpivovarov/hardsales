import { Body, Controller, Get, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { PrivacyService } from './privacy.service';

@Controller()
export class PrivacyController {
  constructor(private readonly auth: AuthService, private readonly privacy: PrivacyService) {}

  @Get('me/data-requests')
  async mine(@Req() request: Request) {
    return this.privacy.own(await this.auth.participant(request));
  }

  @Post('me/data-requests')
  async create(@Req() request: Request, @Body() body: unknown) {
    return this.privacy.create(await this.auth.participant(request, true), body);
  }

  @Get('me/data-requests/:id/export')
  async download(@Req() request: Request, @Param('id') id: string) {
    const { buffer, number } = await this.privacy.download(await this.auth.participant(request), id);
    return new StreamableFile(buffer, { type: 'application/gzip', disposition: `attachment; filename="hwforai-data-${number}.json.gz"` });
  }

  @Get('admin/data-requests')
  async all(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.admin(request);
    return this.privacy.list(query);
  }

  @Get('admin/users/:id/consents')
  async consents(@Req() request: Request, @Param('id') id: string) {
    await this.auth.admin(request);
    return this.privacy.consents(id);
  }

  @Get('admin/email-suppressions/count')
  async suppressionCount(@Req() request: Request) {
    await this.auth.admin(request);
    return this.privacy.suppressionCount();
  }

  @Post('admin/data-requests/:id/export')
  async build(@Req() request: Request, @Param('id') id: string) {
    return this.privacy.build(await this.auth.admin(request), id);
  }

  @Post('admin/data-requests/:id/delete')
  async erase(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.erase(await this.auth.admin(request), id, body);
  }

  @Post('admin/data-requests/:id/reject')
  async reject(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.privacy.reject(await this.auth.admin(request), id, body);
  }
}
