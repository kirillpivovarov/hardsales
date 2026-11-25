import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { AdminService } from './admin.service'
import { CatalogService } from './catalog.service'
import { ChatsService } from './chats.service'

@Controller()
export class MarketController {
  constructor(
    private readonly auth: AuthService,
    private readonly catalog: CatalogService,
    private readonly admin: AdminService,
  ) {}

  @Get('categories')
  categories() {
    return this.catalog.categories()
  }

  @Get('locales')
  locales() {
    return this.admin.locales()
  }

  @Get('content')
  content() {
    return this.admin.content()
  }

  @Get('listings')
  async listings(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.catalog.browse(query, await this.auth.resolve(request))
  }

  @Get('listings/mine')
  async mine(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.catalog.mine(await this.auth.require(request), query)
  }

  @Get('listings/:id')
  async listing(@Req() request: Request, @Param('id') id: string) {
    return this.catalog.detail(await this.auth.require(request), id)
  }

  @Post('listings')
  async create(@Req() request: Request, @Body() body: unknown) {
    return this.catalog.create(await this.auth.require(request), body)
  }

  @Patch('listings/:id')
  async edit(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.change(await this.auth.require(request), id, body)
  }

  @Delete('listings/:id')
  async archive(@Req() request: Request, @Param('id') id: string) {
    return this.catalog.archive(await this.auth.require(request), id)
  }

  @Post('listings/:id/restore')
  @HttpCode(200)
  async restore(@Req() request: Request, @Param('id') id: string) {
    return this.catalog.archive(await this.auth.require(request), id, true)
  }
}

@Controller('chats')
export class ChatsController {
  constructor(private readonly auth: AuthService, private readonly chats: ChatsService) {}

  @Get()
  async list(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.chats.list(await this.auth.require(request), query)
  }

  @Post()
  async create(@Req() request: Request, @Body() body: unknown) {
    return this.chats.create(await this.auth.require(request), body)
  }

  @Get(':id')
  async detail(@Req() request: Request, @Param('id') id: string) {
    return this.chats.detail(await this.auth.require(request), id)
  }

  @Get(':id/messages')
  async messages(@Req() request: Request, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.chats.history(await this.auth.require(request), id, query)
  }

  @Post(':id/messages')
  async send(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.send(await this.auth.require(request), id, body)
  }

  @Patch(':id/read')
  @HttpCode(204)
  async read(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    await this.chats.read(await this.auth.require(request), id, body)
  }

  @Patch(':id/reveal')
  async reveal(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.reveal(await this.auth.require(request), id, body)
  }

  @Post(':id/reviews')
  async review(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.review(await this.auth.require(request), id, body)
  }

  @Post(':id/reports')
  async report(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.report(await this.auth.require(request), id, body)
  }
}
