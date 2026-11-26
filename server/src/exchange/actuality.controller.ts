import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { demoMode } from '../config'
import { ActualityService } from './actuality.service'
import { ExchangeJobs } from './jobs'

@Controller()
export class ActualityController {
  constructor(private readonly auth: AuthService, private readonly actuality: ActualityService, private readonly jobs: ExchangeJobs) {}

  @Post('listings/:id/actuality')
  @HttpCode(200)
  async answer(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.actuality.answer((await this.auth.participant(request)).id, id, body)
  }

  @Post('listings/:id/extend')
  @HttpCode(200)
  async extend(@Req() request: Request, @Param('id') id: string) {
    return this.actuality.extend((await this.auth.participant(request)).id, id)
  }

  @Get('me/actuality')
  async summary(@Req() request: Request) {
    return this.actuality.summary((await this.auth.participant(request)).id)
  }

  @Post('me/actuality/confirm-all')
  @HttpCode(200)
  async confirmAll(@Req() request: Request) {
    return this.actuality.confirmAll((await this.auth.participant(request)).id)
  }

  @Post('me/pause')
  async pause(@Req() request: Request, @Body() body: unknown) {
    return this.actuality.startPause((await this.auth.participant(request)).id, body)
  }

  @Delete('me/pause')
  async endPause(@Req() request: Request) {
    return this.actuality.endPause((await this.auth.participant(request)).id)
  }

  @Post('me/actuality/resume')
  @HttpCode(200)
  async resume(@Req() request: Request) {
    return this.actuality.resume((await this.auth.participant(request)).id)
  }

  @Post('admin/users/:id/actuality/resume')
  @HttpCode(200)
  async staffResume(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.actuality.staffResume(await this.auth.admin(request), id, body)
  }

  @Post('admin/actuality/ask-now')
  @HttpCode(200)
  async askNow(@Req() request: Request) {
    return this.manual('actuality.ask', request)
  }

  @Post('admin/actuality/remind-now')
  @HttpCode(200)
  async remindNow(@Req() request: Request) {
    return this.manual('actuality.remind', request)
  }

  private async manual(name: 'actuality.ask' | 'actuality.remind', request: Request) {
    if (!demoMode()) throw new NotFoundException('Задача не найдена')
    await this.auth.admin(request)
    return this.jobs.runNow(name, 'manual:' + new Date().toISOString())
  }
}
