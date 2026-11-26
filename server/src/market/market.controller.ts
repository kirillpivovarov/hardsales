import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, StreamableFile,
  UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { ContactGuardService } from '../contact-guard/contact-guard.service'
import { AdminService } from './admin.service'
import { CatalogService } from './catalog.service'
import { ChatsService } from './chats.service'
import type { ListingImageUpload } from './listing-media.service'
import { ListingMemberGuard, ListingMultipart, ListingUploadCapacity, listingMutation } from './listing-upload'
import type { ListingMutationRequest } from './listing-upload'
import { object, uuid } from './market.inputs'

@Controller()
export class MarketController {
  constructor(
    private readonly auth: AuthService,
    private readonly catalog: CatalogService,
    private readonly admin: AdminService,
    private readonly contactGuard: ContactGuardService,
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
    return this.catalog.mine(await this.auth.participant(request), query)
  }

  @Get('listings/:id')
  async listing(@Req() request: Request, @Param('id') id: string) {
    return this.catalog.detail(await this.auth.require(request), id)
  }

  @Get('listings/:id/images/:imageId')
  async image(@Req() request: Request, @Param('id') id: string, @Param('imageId') imageId: string) {
    const image = await this.catalog.image(await this.auth.require(request), id, imageId)
    return new StreamableFile(image.content, { type: image.mimeType })
  }

  @Post('listings')
  @UseGuards(ListingMemberGuard)
  @UseInterceptors(ListingUploadCapacity, ListingMultipart)
  async create(@Req() request: ListingMutationRequest, @Body() body: unknown, @UploadedFiles() files?: ListingImageUpload[]) {
    const { data, uploads } = listingMutation(request, body, files)
    await this.contactGuard.assertListing(data, uploads.length, request.listingEditor.id)
    return this.catalog.create(request.listingEditor, data, uploads)
  }

  @Patch('listings/:id')
  @UseGuards(ListingMemberGuard)
  @UseInterceptors(ListingUploadCapacity, ListingMultipart)
  async edit(@Req() request: ListingMutationRequest, @Param('id') id: string, @Body() body: unknown,
    @UploadedFiles() files?: ListingImageUpload[]) {
    const { data, uploads } = listingMutation(request, body, files)
    if (!request.is('multipart/form-data')) await this.catalog.assertEditableBy(request.listingEditor, id)
    await this.contactGuard.assertListing(data, uploads.length, request.listingEditor.id, uuid(id))
    return this.catalog.change(request.listingEditor, id, data, uploads)
  }

  @Delete('listings/:id')
  async archive(@Req() request: Request, @Param('id') id: string) {
    return this.catalog.archive(await this.auth.participant(request), id)
  }

  @Post('listings/:id/restore')
  @HttpCode(200)
  async restore(@Req() request: Request, @Param('id') id: string) {
    return this.catalog.archive(await this.auth.participant(request), id, true)
  }

  @Post('listings/:id/reports')
  async reportPhoto(@Req() request: Request, @Param('id') id: string, @Body() payload: unknown) {
    const user = await this.auth.participant(request)
    const listing = await this.catalog.detail(user, id)
    const body = object(payload)
    return this.contactGuard.reportPhoto(user.id, listing.id, body.details)
  }
}

@Controller('chats')
export class ChatsController {
  constructor(private readonly auth: AuthService, private readonly chats: ChatsService) {}

  @Get()
  async list(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.chats.list(await this.auth.participant(request), query)
  }

  @Post()
  async create(@Req() request: Request, @Body() body: unknown) {
    return this.chats.create(await this.auth.participant(request), body)
  }

  @Get(':id')
  async detail(@Req() request: Request, @Param('id') id: string) {
    return this.chats.detail(await this.auth.participant(request), id)
  }

  @Get(':id/messages')
  async messages(@Req() request: Request, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.chats.history(await this.auth.participant(request), id, query)
  }

  @Post(':id/messages')
  async send(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.send(await this.auth.participant(request), id, body)
  }

  @Patch(':id/read')
  @HttpCode(204)
  async read(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    await this.chats.read(await this.auth.participant(request), id, body)
  }

  @Patch(':id/reveal')
  async reveal(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.reveal(await this.auth.participant(request), id, body)
  }

  @Post(':id/reviews')
  async review(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.review(await this.auth.participant(request), id, body)
  }

  @Post(':id/reports')
  async report(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.report(await this.auth.participant(request), id, body)
  }
}
