import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { RepresentationService } from './representation.service'

@Controller()
export class RepresentationController {
  constructor(private readonly auth: AuthService, private readonly representation: RepresentationService) {}

  @Get('me/representation')
  async state(@Req() request: Request) {
    return this.representation.state(await this.auth.participant(request))
  }

  @Patch('me/representation')
  async mode(@Req() request: Request, @Body() body: unknown) {
    return this.representation.mode(await this.auth.participant(request), body)
  }

  @Get('me/principals')
  async list(@Req() request: Request) {
    return this.representation.list(await this.auth.participant(request))
  }

  @Post('me/principals')
  async add(@Req() request: Request, @Body() body: unknown) {
    return this.representation.add(await this.auth.participant(request), body)
  }

  @Patch('me/principals/:id')
  async edit(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.representation.edit(await this.auth.participant(request), id, body)
  }

  @Delete('me/principals/:id')
  async remove(@Req() request: Request, @Param('id') id: string) {
    return this.representation.remove(await this.auth.participant(request), id)
  }

  @Post('me/principals/:id/email')
  async send(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.representation.sendPrincipal(await this.auth.participant(request), id, body)
  }

  @Post('me/principals/:id/request')
  async request(@Req() request: Request, @Param('id') id: string) {
    return this.representation.requestPlatform(await this.auth.participant(request), id)
  }

  @Get('principal-answers')
  async requestDetail(@Req() request: Request, @Query('principalId') id: string) {
    return this.representation.platformView(await this.auth.participant(request), id)
  }

  @Post('principal-answers')
  async answer(@Req() request: Request, @Body() body: unknown) {
    return this.representation.answerPlatform(await this.auth.participant(request), body)
  }

  @Put('me/agent-fee')
  async fee(@Req() request: Request, @Body() body: unknown) {
    return this.representation.fee(await this.auth.participant(request), body)
  }

  @Post('me/company-email')
  async companyEmail(@Req() request: Request, @Body() body: unknown) {
    return this.representation.ownEmail(await this.auth.participant(request), body)
  }

  @Get('admin/principals')
  async queue(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request)
    return this.representation.adminList(query)
  }

  @Post('admin/users/:userId/principals/:id/confirm')
  async confirm(@Req() request: Request, @Param('userId') userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.representation.confirm(await this.auth.staff(request), userId, id, body)
  }
}
