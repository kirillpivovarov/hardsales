import {
  BadRequestException, Injectable, PayloadTooLargeException, ServiceUnavailableException,
} from '@nestjs/common'
import type { CallHandler, CanActivate, ExecutionContext, NestInterceptor } from '@nestjs/common'
import { FilesInterceptor } from '@nestjs/platform-express'
import type { Request } from 'express'
import { defer, finalize } from 'rxjs'
import { AuthService } from '../auth/auth.service'
import type { ParticipantRole, SessionUser, StaffSession } from '../auth/auth.types'
import { CatalogService } from './catalog.service'
import { MAX_LISTING_IMAGE_BYTES, MAX_LISTING_IMAGES, type ListingImageUpload } from './listing-media.service'
import { object } from './market.inputs'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_REQUEST_BYTES = MAX_LISTING_IMAGE_BYTES * MAX_LISTING_IMAGES + 512 * 1024
const MAX_CONCURRENT_UPLOADS = 2

export type ListingMutationRequest = Request<{ id?: string }> & { listingEditor: SessionUser<ParticipantRole> }
export type StaffListingMutationRequest = Request<{ id?: string }> & { listingEditor: StaffSession }

// Guards run before the interceptor buffers the multipart body.
@Injectable()
export class ListingMemberGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly catalog: CatalogService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ListingMutationRequest>()
    const user = await this.auth.participant(request)
    if (request.params.id && request.is('multipart/form-data')) {
      await this.catalog.assertEditableBy(user, request.params.id)
    }
    request.listingEditor = user
    return true
  }
}

@Injectable()
export class ListingStaffGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<StaffListingMutationRequest>()
    request.listingEditor = await this.auth.staff(request)
    return true
  }
}

@Injectable()
export class ListingUploadCapacity implements NestInterceptor {
  private active = 0

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>()
    if (!request.is('multipart/form-data')) return next.handle()
    if (Number(request.get('content-length')) > MAX_REQUEST_BYTES) {
      throw new PayloadTooLargeException('Слишком большой запрос с фотографиями.')
    }
    if (this.active >= MAX_CONCURRENT_UPLOADS) {
      throw new ServiceUnavailableException('Загрузка фотографий временно занята. Повторите попытку.')
    }
    this.active += 1
    return defer(() => next.handle()).pipe(finalize(() => { this.active -= 1 }))
  }
}

export const ListingMultipart = FilesInterceptor('images', MAX_LISTING_IMAGES, {
  // Streamed limits cover chunked requests as well. Only one JSON field is accepted.
  limits: {
    files: MAX_LISTING_IMAGES, fileSize: MAX_LISTING_IMAGE_BYTES, fields: 1,
    fieldSize: MAX_MANIFEST_BYTES, parts: MAX_LISTING_IMAGES + 1, fieldNameSize: 16,
  },
})

export function listingMutation(request: Request, body: unknown, files?: ListingImageUpload[]) {
  if (!request.is('multipart/form-data')) return { data: body, uploads: [] }
  const fields = object(body)
  if (typeof fields.data !== 'string' || Object.keys(fields).length !== 1) {
    throw new BadRequestException('Передайте данные объявления в поле data.')
  }
  let data: unknown
  try {
    data = JSON.parse(fields.data)
  } catch {
    throw new BadRequestException('Поле data должно содержать корректный JSON.')
  }
  return { data, uploads: files ?? [] }
}
