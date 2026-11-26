import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { MatchingModule } from '../matching/matching.module'
import { LotDetection } from './lot-detection'
import { LotGroupsService } from './lot-groups.service'

@Controller()
class MemberLotsController {
  constructor(private readonly auth: AuthService, private readonly lots: LotGroupsService) {}

  @Get('listings/:id/lot-members')
  async members(@Req() req: Request, @Param('id') id: string) {
    return this.lots.publicMembers(await this.auth.participant(req), id)
  }

  @Get('me/lot-requests')
  async requests(@Req() req: Request) {
    return this.lots.myRequests(await this.auth.participant(req))
  }

  @Post('me/lot-requests/:id')
  @HttpCode(200)
  async answer(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.lots.answer(await this.auth.participant(req), id, body)
  }

  @Post('listings/:id/duplicate-appeal')
  @HttpCode(200)
  async appeal(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.lots.appeal(await this.auth.participant(req), id, body)
  }
}

@Controller('admin/lot-groups')
class StaffLotsController {
  constructor(private readonly auth: AuthService, private readonly lots: LotGroupsService) {}

  @Get()
  async list(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(req)
    return this.lots.list(query)
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    await this.auth.staff(req)
    return this.lots.detail(id)
  }

  @Post(':id/principal-requests')
  @HttpCode(200)
  async requestPrincipals(@Req() req: Request, @Param('id') id: string) {
    return this.lots.requestPrincipals(await this.auth.staff(req), id)
  }

  @Post(':id/shared-principal')
  @HttpCode(200)
  async shared(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.lots.sharedPrincipal(await this.auth.staff(req), id, body)
  }

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.lots.resolve(await this.auth.staff(req), id, body)
  }

  @Post(':id/dissolve')
  @HttpCode(200)
  async dissolve(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.lots.dissolve(await this.auth.staff(req), id, body)
  }

  @Post(':id/members/:listingId/restore')
  @HttpCode(200)
  async restore(@Req() req: Request, @Param('id') id: string, @Param('listingId') listingId: string, @Body() body: unknown) {
    return this.lots.restore(await this.auth.staff(req), id, listingId, body)
  }
}

@Module({ imports: [MatchingModule], providers: [LotGroupsService, LotDetection], controllers: [MemberLotsController, StaffLotsController] })
export class LotGroupsModule {}
