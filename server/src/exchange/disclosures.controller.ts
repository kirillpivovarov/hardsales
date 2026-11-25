import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { DisclosuresService } from './disclosures.service'

@Controller()
export class DisclosuresController {
  constructor(private readonly auth: AuthService, private readonly disclosures: DisclosuresService) {}

  @Get('disclosures')
  async list(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.disclosures.list(await this.auth.participant(request), query)
  }

  @Get('disclosures/:id')
  async detail(@Req() request: Request, @Param('id') id: string) {
    return this.disclosures.detail(await this.auth.participant(request), id)
  }

  @Post('disclosures/:id/already-known')
  async alreadyKnown(@Req() request: Request, @Param('id') id: string) {
    return this.disclosures.alreadyKnown(await this.auth.participant(request), id)
  }

  @Get('admin/disclosures')
  async adminList(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.disclosures.list(await this.auth.staff(request), query, true)
  }

  @Get('admin/disclosures/:id')
  async adminDetail(@Req() request: Request, @Param('id') id: string) {
    return this.disclosures.detail(await this.auth.staff(request), id, true)
  }

  @Post('admin/disclosures/:id/notes')
  async note(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.disclosures.note(await this.auth.staff(request), id, body)
  }
}
