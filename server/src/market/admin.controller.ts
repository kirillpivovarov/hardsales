import {
  BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Patch, Post,
  Put, Query, Req, UnauthorizedException, UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { ContactGuardService } from '../contact-guard/contact-guard.service'
import { DatabaseService } from '../database/database.service'
import { AdminService } from './admin.service'
import { CatalogService } from './catalog.service'
import type { ListingImageUpload } from './listing-media.service'
import { ListingStaffGuard, ListingMultipart, ListingUploadCapacity, listingMutation } from './listing-upload'
import type { StaffListingMutationRequest } from './listing-upload'
import { oneOf, uuid } from './market.inputs'

@Controller('admin')
export class AdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly admin: AdminService,
    private readonly catalog: CatalogService,
    private readonly db: DatabaseService,
    private readonly contactGuard: ContactGuardService,
  ) {}

  @Get('users')
  async users(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.admin.users(await this.auth.staff(request), query)
  }

  @Get('users/:id')
  async user(@Req() request: Request, @Param('id') id: string) {
    return this.admin.user(await this.auth.staff(request), id)
  }

  @Patch('users/:id')
  async editUser(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.editUser(await this.auth.staff(request), id, body)
  }

  @Patch('users/:id/status')
  async userStatus(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.status(await this.auth.staff(request), 'users', id, body)
  }

  @Get('users/:id/listing-options')
  async listingOptions(@Req() request: Request, @Param('id') id: string) {
    await this.auth.staff(request)
    return this.catalog.staffListingOptions(id)
  }

  @Post('users/:id/listings')
  @UseGuards(ListingStaffGuard)
  @UseInterceptors(ListingUploadCapacity, ListingMultipart)
  async createForOwner(@Req() request: StaffListingMutationRequest, @Param('id') id: string, @Body() body: unknown,
    @UploadedFiles() files?: ListingImageUpload[]) {
    const { data, uploads } = listingMutation(request, body, files)
    await this.contactGuard.assertListing(data, uploads.length)
    return this.catalog.createForOwner(request.listingEditor, id, data, uploads)
  }

  @Get('listings')
  async listings(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request)
    return this.catalog.administrativeListings(query)
  }

  @Get('listings/:id')
  async listing(@Req() request: Request, @Param('id') id: string) {
    await this.auth.staff(request)
    return this.catalog.show(this.db, uuid(id))
  }

  @Patch('listings/:id')
  @UseGuards(ListingStaffGuard)
  @UseInterceptors(ListingUploadCapacity, ListingMultipart)
  async editListing(@Req() request: StaffListingMutationRequest, @Param('id') id: string, @Body() body: unknown,
    @UploadedFiles() files?: ListingImageUpload[]) {
    const { data, uploads } = listingMutation(request, body, files)
    await this.contactGuard.assertListing(data, uploads.length)
    return this.admin.editListing(request.listingEditor, id, data, uploads)
  }

  @Patch('listings/:id/status')
  async listingStatus(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.status(await this.auth.staff(request), 'listings', id, body)
  }

  @Post('listings/:id/review')
  async reviewListing(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.reviewListing(await this.auth.staff(request), id, body)
  }

  @Get('categories')
  async categories(@Req() request: Request) {
    await this.auth.staff(request)
    return this.catalog.categories(true)
  }

  @Post('categories')
  async createCategory(@Req() request: Request, @Body() body: unknown) {
    return this.admin.saveCategory(await this.auth.staff(request), null, body)
  }

  @Patch('categories/:id')
  async editCategory(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.saveCategory(await this.auth.staff(request), id, body)
  }

  @Get('reviews')
  async reviews(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request)
    return this.admin.reviews(query)
  }

  @Get('reviews/:id')
  async review(@Req() request: Request, @Param('id') id: string) {
    await this.auth.staff(request)
    return this.admin.review(id)
  }

  @Patch('reviews/:id/status')
  async reviewStatus(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.status(await this.auth.staff(request), 'reviews', id, body)
  }

  @Get('reports')
  async reports(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.admin.reports(await this.auth.staff(request), query)
  }

  @Get('reports/:id')
  async report(@Req() request: Request, @Param('id') id: string) {
    return this.admin.report(await this.auth.staff(request), id)
  }

  @Get('reports/:id/messages')
  async evidence(@Req() request: Request, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.admin.evidence(await this.auth.staff(request), id, query)
  }

  @Patch('reports/:id/status')
  async reportStatus(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.status(await this.auth.staff(request), 'reports', id, body)
  }

  @Get('locales')
  async locales(@Req() request: Request) {
    await this.auth.staff(request)
    return this.admin.locales(true)
  }

  @Put('locales/:code')
  async locale(@Req() request: Request, @Param('code') code: string, @Body() body: unknown) {
    return this.admin.saveLocale(await this.auth.staff(request), code, body)
  }

  @Get('content')
  async content(@Req() request: Request) {
    await this.auth.staff(request)
    return this.admin.content(true)
  }

  @Put('content/:key')
  async page(@Req() request: Request, @Param('key') key: string, @Body() body: unknown) {
    return this.admin.saveContent(await this.auth.staff(request), key, body)
  }

  @Get('audit')
  async audit(@Req() request: Request, @Query() query: Record<string, unknown>) {
    await this.auth.staff(request)
    return this.admin.history(query)
  }
}

@Controller('agent/moderation')
export class AgentModerationController {
  constructor(private readonly admin: AdminService) {}

  @Patch(':entity/:id')
  async moderate(@Param('entity') entity: string, @Param('id') id: string, @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined, @Headers('idempotency-key') idempotency: string | undefined) {
    const token = process.env.MODERATION_AGENT_TOKEN
    if (!token || token.length < 32) throw new NotFoundException()
    const match = typeof authorization === 'string' && /^Bearer (\S+)$/i.exec(authorization)
    const hash = (value: string) => createHash('sha256').update(value).digest()
    if (!match || !timingSafeEqual(hash(match[1]), hash(token))) {
      throw new UnauthorizedException('Требуется токен агента модерации')
    }
    if (typeof idempotency !== 'string' || !/^[a-z0-9._-]{8,128}$/i.test(idempotency)) {
      throw new BadRequestException('Передайте Idempotency-Key из 8–128 символов')
    }
    const kind = oneOf(entity, ['users', 'listings'], 'Сущность')
    return this.admin.status('agent:moderation', kind, id, body, idempotency)
  }
}
