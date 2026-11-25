import { Body, Controller, Get, Module, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { CatalogSyncService } from './catalog-sync.service'
import { ModelsService } from './models.service'

@Controller('models')
class ModelsController {
  constructor(private readonly auth: AuthService, private readonly models: ModelsService) {}

  @Get()
  async browse(@Req() req: Request, @Query() query: Record<string, unknown>) {
    return this.models.browse(await this.auth.require(req), query)
  }

  @Get('suggest')
  async suggest(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.auth.require(req)
    return this.models.suggest(query)
  }

  @Get(':id/analogs')
  async analogs(@Req() req: Request, @Param('id') id: string) {
    return this.models.analogs(await this.auth.require(req), id)
  }

  @Post('proposals')
  async propose(@Req() req: Request, @Body() input: unknown) {
    return this.models.proposal(await this.auth.participant(req), input)
  }
}

@Controller('admin/models')
class AdminModelsController {
  constructor(private readonly auth: AuthService, private readonly models: ModelsService) {}

  @Get()
  async list(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(req)
    return this.models.adminList(query)
  }

  @Get('options')
  async options(@Req() req: Request) {
    await this.auth.staff(req)
    return this.models.adminOptions()
  }

  @Post()
  async create(@Req() req: Request, @Body() input: unknown) {
    return this.models.save(await this.auth.staff(req), null, input)
  }

  @Post('backfill-preview')
  async preview(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(req)
    return this.models.backfillPreview(query)
  }

  @Post('backfill-apply')
  async backfill(@Req() req: Request, @Body() input: unknown) {
    return this.models.backfillApply(await this.auth.staff(req), input)
  }

  @Patch(':id')
  async edit(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.models.save(await this.auth.staff(req), id, input)
  }

  @Post(':id/approve')
  async approve(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.models.approve(await this.auth.staff(req), id, input)
  }

  @Post(':id/merge')
  async merge(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.models.merge(await this.auth.staff(req), id, input)
  }

  @Patch(':id/status')
  async status(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.models.status(await this.auth.staff(req), id, input)
  }
}

@Controller('admin/catalog-sync')
class CatalogSyncController {
  constructor(private readonly auth: AuthService, private readonly sync: CatalogSyncService) {}

  @Get('items')
  async items(@Req() req: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(req)
    return this.sync.items(query)
  }

  @Get('sources')
  async sources(@Req() req: Request) {
    await this.auth.staff(req)
    return this.sync.sources()
  }

  @Put('sources/:code')
  async editSource(@Req() req: Request, @Param('code') code: string, @Body() input: unknown) {
    return this.sync.saveSource(await this.auth.admin(req), code, input)
  }

  @Post('run')
  async run(@Req() req: Request, @Body() input: unknown) {
    return this.sync.runNow(await this.auth.admin(req), input)
  }

  @Post('items/:id/decide')
  async decide(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
    return this.sync.decide(await this.auth.staff(req), id, input)
  }
}

@Module({
  controllers: [ModelsController, AdminModelsController, CatalogSyncController],
  providers: [ModelsService, CatalogSyncService],
  exports: [ModelsService],
})
export class ModelsModule {}
