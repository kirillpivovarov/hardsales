import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Module, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { demoMode } from '../config';
import { DatabaseService } from '../database/database.service';
import { auditExchange } from '../exchange/audit';
import { ExchangeJobs } from '../exchange/jobs';
import { lockTrustStaff } from '../exchange/trust-access';
import { object, oneOf } from '../market/market.inputs';
import { MatchingModule } from '../matching/matching.module';
import { MailOperations } from './mail-operations';
import { OpsMonitor } from './ops-monitor';
import { RulesPublication } from './rules-publication';
import { operationalJobName, TrialPreset } from './trial-preset';

@Controller('admin')
class OpsAdminController {
  constructor(private readonly auth: AuthService, private readonly db: DatabaseService,
    private readonly trial: TrialPreset, private readonly rules: RulesPublication, private readonly jobs: ExchangeJobs,
    private readonly mail: MailOperations) {}

  @Get('presets/trial')
  async preview(@Req() request: Request) {
    await this.auth.admin(request);
    const { checks, changes, firstActualityAt, fxRates } = await this.trial.preview();
    return { checks, changes, firstActualityAt, fxRates };
  }

  @Post('presets/trial')
  async apply(@Req() request: Request, @Body() input: unknown) {
    const actor = await this.auth.admin(request);
    return this.trial.apply(actor, object(input).fxRates);
  }

  @Get('jobs/available')
  async jobList(@Req() request: Request) {
    return { items: this.jobs.available(await this.auth.staff(request)).map(item => ({
      ...item, title: operationalJobName(item.name),
      requiresConfirmation: !demoMode() && ['actuality.ask', 'actuality.remind'].includes(item.name),
    })) };
  }

  @Post('jobs/:name/run')
  @HttpCode(200)
  async jobRun(@Req() request: Request, @Param('name') name: string, @Body() input: unknown) {
    const actor = await this.auth.staff(request);
    if (actor.role === 'ADMIN' && !demoMode() && ['actuality.ask', 'actuality.remind'].includes(name) &&
      object(input ?? {}).confirm !== true) {
      throw new BadRequestException('Подтвердите отправку вопроса участникам сейчас');
    }
    return this.jobs.runManual(actor, name);
  }

  @Get('mail-queue')
  async mailQueue(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.mail.queue(await this.auth.staff(request), query);
  }

  @Post('mail-queue/:source/:id/retry')
  @HttpCode(200)
  async retry(@Req() request: Request, @Param('source') source: string, @Param('id') id: string) {
    return this.mail.retry(await this.auth.staff(request), source, id);
  }

  @Post('mail/test')
  @HttpCode(200)
  async testMail(@Req() request: Request, @Body() input: unknown) {
    return this.mail.test(await this.auth.admin(request), input);
  }

  @Get('readiness')
  async readiness(@Req() request: Request) {
    await this.auth.admin(request);
    return this.trial.readiness();
  }

  @Put('readiness/:key')
  async attest(@Req() request: Request, @Param('key') rawKey: string, @Body() input: unknown) {
    const actor = await this.auth.admin(request);
    const key = oneOf(rawKey, ['mailboxes', 'monitor', 'invitations', 'email'], 'Проверка');
    const checked = object(input).checked;
    if (typeof checked !== 'boolean') throw new BadRequestException('Укажите результат проверки');
    await this.db.transaction(async client => {
      await lockTrustStaff(client, actor);
      await client.query(`
        INSERT INTO readiness_attestations(key,checked,updated_by) VALUES ($1,$2,$3) ON CONFLICT (key)
        DO UPDATE SET checked=EXCLUDED.checked,updated_by=EXCLUDED.updated_by,updated_at=now()
      `, [key, checked, actor.id]);
      await auditExchange(client, actor, 'readiness', key, 'attest', null, { checked });
    });
    return this.trial.readiness();
  }

  @Get('rules/schedule')
  async rulesStatus(@Req() request: Request) {
    await this.auth.admin(request);
    return this.rules.status();
  }

  @Post('rules/schedule')
  async rulesSchedule(@Req() request: Request, @Body() input: unknown) {
    return this.rules.schedule(await this.auth.admin(request), input);
  }
}

@Controller('health/ops')
class OpsHealthController {
  constructor(private readonly ops: OpsMonitor) {}

  @Get()
  async status(@Headers('authorization') token: string | undefined, @Res({ passthrough: true }) response: Response) {
    this.ops.requireToken(token);
    response.setHeader('Cache-Control', 'no-store');
    try {
      const { ok, backupReady: _ready, ...metrics } = await this.ops.status();
      response.status(ok ? 200 : 503);
      return { db: 'ok', ...metrics };
    } catch {
      response.status(503);
      return { db: 'unavailable' };
    }
  }

  @Post('backup')
  @HttpCode(204)
  async backup(@Headers('authorization') token: string | undefined, @Body() input: unknown) {
    this.ops.requireToken(token);
    await this.ops.report(input);
  }
}

@Module({
  imports: [MatchingModule],
  controllers: [OpsAdminController, OpsHealthController],
  providers: [OpsMonitor, TrialPreset, RulesPublication, MailOperations],
})
export class OpsModule {}
