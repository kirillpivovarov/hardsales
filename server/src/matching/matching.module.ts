import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { MatchingService } from './matching.service';

@Controller('matches')
class MatchesController {
  constructor(private readonly auth: AuthService, private readonly matches: MatchingService) {}

  @Get()
  async list(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.matches.list((await this.auth.participant(request)).id, query);
  }

  @Get('counts')
  async counts(@Req() request: Request) {
    return this.matches.counts((await this.auth.participant(request)).id);
  }

  @Get(':id')
  async detail(@Req() request: Request, @Param('id') id: string) {
    return this.matches.detail((await this.auth.participant(request)).id, id);
  }

  @Post(':id/chat')
  @HttpCode(200)
  async chat(@Req() request: Request, @Param('id') id: string) {
    return this.matches.chat((await this.auth.participant(request)).id, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  async decline(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.matches.decline((await this.auth.participant(request)).id, id, body);
  }
}

@Controller('admin')
class AdminMatchesController {
  constructor(private readonly auth: AuthService, private readonly matches: MatchingService) {}

  @Get('matches')
  async list(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.admin(request);
    return this.matches.adminList(query);
  }

  @Get('fx-rates')
  async rates(@Req() request: Request) {
    await this.auth.admin(request);
    return this.matches.rates();
  }

  @Put('fx-rates/:currency')
  async putRate(@Req() request: Request, @Param('currency') currency: string, @Body() body: unknown) {
    return this.matches.putRate(await this.auth.admin(request), currency, body);
  }
}

@Module({
  controllers: [MatchesController, AdminMatchesController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
