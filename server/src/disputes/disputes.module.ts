import {
  BadRequestException, Body, CallHandler, CanActivate, Controller, ExecutionContext, Get, HttpException, Injectable, Module,
  NotFoundException, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors, type NestInterceptor,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Request, Response } from 'express'
import { finalize } from 'rxjs'
import { AuthModule } from '../auth/auth.module'
import { AuthService } from '../auth/auth.service'
import { isStaffRole } from '../auth/auth.types'
import { ExchangeActions } from '../exchange/actions'
import { documentLimit, type DocumentUpload } from '../exchange/trust-files'
import { DisputesService } from './disputes.service'

type MaterialRequest = Request & { disputeUserId: string }

@Injectable()
class MaterialGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly disputes: DisputesService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<MaterialRequest>()
    request.disputeUserId = (await this.auth.participant(request)).id
    await this.disputes.assertAccess({ id: request.disputeUserId, staff: false }, String(request.params.id ?? ''))
    return true
  }
}

@Injectable()
class AppealUploadGuard implements CanActivate {
  constructor(private readonly actions: ExchangeActions) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>()
    const action = await this.actions.open(String(request.params.token ?? ''), request.ip ?? 'unknown')
    if (!('purpose' in action) || action.purpose !== 'dispute.review') throw new NotFoundException('Ссылка не найдена')
    return true
  }
}

@Injectable()
class MaterialCapacity implements NestInterceptor {
  private active = 0

  intercept(_context: ExecutionContext, next: CallHandler) {
    if (this.active >= 4) throw new HttpException('Загрузка занята. Попробуйте немного позже.', 429)
    this.active++
    return next.handle().pipe(finalize(() => { this.active-- }))
  }
}

@Controller()
class DisputesController {
  constructor(private readonly auth: AuthService, private readonly disputes: DisputesService, private readonly actions: ExchangeActions) {}

  @Post('disputes')
  async open(@Req() request: Request, @Body() body: unknown) {
    return this.disputes.open((await this.auth.participant(request)).id, body)
  }

  @Get('disputes')
  async own(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.disputes.list({ id: (await this.auth.participant(request)).id, staff: false }, query)
  }

  @Get('disclosures/:id/dispute-deals')
  async disclosureDeals(@Req() request: Request, @Param('id') id: string) {
    return this.disputes.disclosureDeals((await this.auth.participant(request)).id, id)
  }

  @Get('disputes/:id')
  async record(@Req() request: Request, @Param('id') id: string) {
    const actor = await this.auth.require(request)
    const staff = isStaffRole(actor.role) ? await this.auth.staff(request) : undefined
    return this.disputes.detail({ id: actor.id, staff: !!staff }, id, staff)
  }

  @Post('disputes/:id/position')
  async position(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.disputes.position((await this.auth.participant(request)).id, id, body)
  }

  @Post('disputes/:id/materials')
  @UseGuards(MaterialGuard)
  @UseInterceptors(MaterialCapacity, FileInterceptor('file', {
    limits: { fileSize: documentLimit, files: 1, fields: 1, fieldSize: 8192, parts: 3 },
  }))
  material(@Req() request: MaterialRequest, @Param('id') id: string,
    @Body('data') raw: unknown, @UploadedFile() file?: DocumentUpload) {
    let data: unknown
    try {
      if (raw !== undefined && typeof raw !== 'string') throw new Error()
      data = raw === undefined ? {} : JSON.parse(raw)
    } catch {
      throw new BadRequestException('Передайте описание материала в поле data')
    }
    return this.disputes.material(request.disputeUserId, id, data, file)
  }

  @Get('disputes/:id/materials/:materialId/file')
  async download(@Req() request: Request, @Param('id') id: string, @Param('materialId') material: string, @Res() response: Response) {
    const actor = await this.auth.require(request)
    const staff = isStaffRole(actor.role) ? await this.auth.staff(request) : undefined
    const file = await this.disputes.download({ id: actor.id, staff: !!staff }, id, material, staff)
    response.attachment(file.file_name).type(file.mime_type)
    response.set({
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    })
    response.send(file.content)
  }

  @Post('disputes/:id/messages')
  async message(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const actor = await this.auth.require(request)
    return isStaffRole(actor.role) ? this.disputes.ask(await this.auth.staff(request), id, body) : this.disputes.reply(actor.id, id, body)
  }

  @Post('disputes/:id/review')
  async appeal(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.disputes.appeal((await this.auth.participant(request)).id, id, body)
  }

  @Post('disputes/review-link/:token')
  @UseGuards(AppealUploadGuard)
  @UseInterceptors(MaterialCapacity, FileInterceptor('file', {
    limits: { fileSize: documentLimit, files: 1, fields: 1, fieldSize: 16000, parts: 3 },
  }))
  uploadAppeal(@Req() request: Request, @Param('token') token: string,
    @Body('text') text: unknown, @UploadedFile() file?: DocumentUpload) {
    return this.actions.open(token, request.ip ?? 'unknown', { body: { text, file } })
  }

  @Post('disputes/:id/withdraw')
  async withdraw(@Req() request: Request, @Param('id') id: string) {
    return this.disputes.withdraw((await this.auth.participant(request)).id, id)
  }

  @Get('admin/disputes')
  async queue(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.disputes.list({ id: (await this.auth.staff(request)).id, staff: true }, query)
  }

  @Get('admin/disputes/:id/evidence')
  async evidence(@Req() request: Request, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.disputes.evidence(await this.auth.staff(request), id, query)
  }

  @Post('admin/disputes/:id/notify')
  async notify(@Req() request: Request, @Param('id') id: string) {
    return this.disputes.notify(await this.auth.staff(request), id)
  }

  @Post('admin/disputes/:id/start-review')
  async start(@Req() request: Request, @Param('id') id: string) {
    return this.disputes.startReview(await this.auth.staff(request), id)
  }

  @Post('admin/disputes/:id/decide')
  async decide(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.disputes.decide(await this.auth.staff(request), id, body)
  }
}

@Module({ imports: [AuthModule], controllers: [DisputesController], providers: [DisputesService, MaterialGuard, AppealUploadGuard, MaterialCapacity] })
export class DisputesModule {}
