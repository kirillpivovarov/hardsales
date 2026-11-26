import { Controller, Get, Header, Module, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { PilotService, pilotCsv } from './pilot.service';

@Controller('admin')
class PilotController {
  constructor(private readonly auth: AuthService, private readonly pilot: PilotService) {}

  @Get('pilot-metrics')
  async metrics(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request);
    return this.pilot.metrics(query);
  }

  @Get('pilot-metrics.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async csv(@Req() request: Request, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) response: Response) {
    await this.auth.staff(request);
    const { from, to, days } = await this.pilot.metrics(query);
    response.attachment(`pilot-metrics-${from}-${to}.csv`);
    return pilotCsv(days);
  }

  @Get('pilot-accounts')
  async accounts(@Req() request: Request, @Query('q') q: unknown) {
    await this.auth.admin(request);
    return this.pilot.accounts(q);
  }
}

@Module({ controllers: [PilotController], providers: [PilotService] })
export class PilotModule {}
