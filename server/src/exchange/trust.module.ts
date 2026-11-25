import {
  BadRequestException, Body, CallHandler, CanActivate, Controller, Delete, ExecutionContext, Get, Global,
  HttpCode, HttpException, Injectable, Module, NestInterceptor, Param, Patch, Post, Put, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Request, Response } from 'express'
import { finalize } from 'rxjs'
import { AuthModule } from '../auth/auth.module'
import { AuthService } from '../auth/auth.service'
import { isStaffRole } from '../auth/auth.types'
import { DealsService } from './deals.service'
import { documentLimit, type DocumentUpload } from './trust-files'
import { paymentCompatibility, paymentForms } from './trust-score'
import { TrustService } from './trust.service'
import { VerificationService } from './verification.service'

type DocumentRequest = Request & { documentUserId: string }

@Injectable()
class DocumentGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly trust: TrustService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<DocumentRequest>()
    request.documentUserId = (await this.auth.participant(request)).id
    await this.trust.requireEnabled()
    return true
  }
}

@Injectable()
class DocumentCapacity implements NestInterceptor {
  private active = 0

  intercept(_context: ExecutionContext, next: CallHandler) {
    if (this.active >= 4) throw new HttpException('Загрузка занята. Попробуйте немного позже.', 429)
    this.active++
    return next.handle().pipe(finalize(() => { this.active-- }))
  }
}

@Controller()
class TrustController {
  constructor(
    private readonly auth: AuthService,
    private readonly trust: TrustService,
    private readonly verification: VerificationService,
    private readonly deals: DealsService,
  ) {}

  @Get('payment-terms')
  async terms() {
    await this.trust.requireEnabled()
    return { terms: paymentForms.payment_terms, rules: paymentCompatibility.rules, fallback: paymentCompatibility.fallback }
  }

  @Get('me/trust')
  async profile(@Req() request: Request) {
    return this.trust.summary((await this.auth.participant(request)).id)
  }

  @Post('documents')
  @UseGuards(DocumentGuard)
  @UseInterceptors(DocumentCapacity, FileInterceptor('file', {
    limits: { fileSize: documentLimit, files: 1, fields: 1, fieldSize: 4096, parts: 3 },
  }))
  upload(@Req() request: DocumentRequest, @UploadedFile() file: DocumentUpload | undefined, @Body('data') raw: unknown) {
    let data: unknown
    try {
      if (typeof raw !== 'string') throw new Error()
      data = JSON.parse(raw)
    } catch {
      throw new BadRequestException('Укажите реквизиты документа в поле data')
    }
    return this.verification.upload(request.documentUserId, file, data)
  }

  @Get('documents')
  async docs(@Req() request: Request, @Query('listingId') listing?: string, @Query('dealId') deal?: string) {
    return this.verification.documents((await this.auth.participant(request)).id, listing, deal)
  }

  @Get('documents/:id/file')
  async download(@Req() request: Request, @Param('id') id: string, @Res() response: Response) {
    const current = await this.auth.require(request)
    const actor = isStaffRole(current.role) ? await this.auth.staff(request) : current
    const file = await this.verification.download(id, actor)
    response.attachment(file.file_name).type(file.mime_type)
    response.set({
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    response.send(file.content)
  }

  @Get('deals')
  async listDeals(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.deals.list((await this.auth.participant(request)).id, query)
  }

  @Get('deals/:id')
  async getDeal(@Req() request: Request, @Param('id') id: string) {
    return this.deals.show((await this.auth.participant(request)).id, id)
  }

  @Post('deals/:id/status')
  @HttpCode(200)
  async setDealStatus(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.deals.changeStatus((await this.auth.participant(request)).id, id, input)
  }

  @Get('admin/verification')
  async queue(@Req() request: Request, @Query('q') search?: string) {
    return this.verification.queue(await this.auth.staff(request), search)
  }

  @Post('admin/documents/:id/approve')
  @HttpCode(200)
  async approve(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.review(await this.auth.staff(request), id, true, input)
  }

  @Post('admin/documents/:id/reject')
  @HttpCode(200)
  async reject(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.review(await this.auth.staff(request), id, false, input)
  }

  @Post('admin/users/:id/verify')
  @HttpCode(200)
  async verify(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.decide(await this.auth.staff(request), id, 'verify', input)
  }

  @Post('admin/users/:id/verification-reject')
  @HttpCode(200)
  async refuse(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.decide(await this.auth.staff(request), id, 'reject', input)
  }

  @Post('admin/users/:id/restrict')
  @HttpCode(200)
  async restrict(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.decide(await this.auth.staff(request), id, 'restrict', input)
  }

  @Post('admin/users/:id/day-codes')
  async issueDayCode(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.dayCode(await this.auth.staff(request), id, input)
  }

  @Post('admin/users/:id/penalties')
  async penalty(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.penalty(await this.auth.staff(request), id, input)
  }

  @Patch('admin/users/:id/link-group')
  async linkGroup(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.verification.linkGroup(await this.auth.staff(request), id, input)
  }

  @Post('admin/deals/:id/verify')
  @HttpCode(200)
  async verifyDeal(@Req() request: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.deals.check(await this.auth.staff(request), id, input)
  }

  @Get('admin/corridors')
  async getCorridors(@Req() request: Request) {
    return this.verification.corridors(await this.auth.admin(request))
  }

  @Put('admin/corridors/:modelId/:basis')
  async putCorridor(@Req() request: Request, @Param('modelId') modelId: string, @Param('basis') basis: string, @Body() input: unknown) {
    return this.verification.saveCorridor(await this.auth.admin(request), modelId, basis, input)
  }

  @Delete('admin/corridors/:modelId/:basis')
  @HttpCode(204)
  async deleteCorridor(@Req() request: Request, @Param('modelId') modelId: string, @Param('basis') basis: string) {
    return this.verification.saveCorridor(await this.auth.admin(request), modelId, basis)
  }
}

@Global()
@Module({
  imports: [AuthModule],
  controllers: [TrustController],
  providers: [TrustService, VerificationService, DealsService, DocumentGuard, DocumentCapacity],
  exports: [TrustService],
})
export class TrustModule {}
