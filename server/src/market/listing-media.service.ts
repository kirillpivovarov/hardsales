import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common'
import type { PoolClient } from 'pg'
import sharp from 'sharp'
import { uuid } from './market.inputs'

export const MAX_LISTING_IMAGES = 10
export const MAX_LISTING_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_SIDE = 900
const MAX_INPUT_PIXELS = 25_000_000
const MAX_STORED_BYTES = 2 * 1024 * 1024
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type ListingImageUpload = { buffer: Buffer }
export type ListingImage = { id: string; url: string; width: number; height: number }
export type ListingImageData = { content: Buffer; mimeType: string }
type ProcessedImage = { content: Buffer; width: number; height: number }
export type ListingImageUpdate = (string | ProcessedImage)[]

// The vector wordmark keeps rendering stable on container images without system fonts.
function watermark(width: number, height: number) {
  const margin = Math.min(10, Math.floor(Math.min(width, height) / 8))
  const badgeWidth = Math.max(1, Math.min(146, width - 2 * margin, 4 * (height - 2 * margin)))
  const badgeHeight = Math.max(1, Math.floor(badgeWidth / 4))
  const input = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${badgeWidth}" height="${badgeHeight}" viewBox="0 0 108 27">
    <g opacity=".65">
      <rect width="108" height="27" rx="5" fill="#151713"/>
      <path d="M9 6v15m0-8q2-3 6-3 4 0 4 4v7 M23 10l2 11 4-8 4 8 2-11
        M40 21V10q0-5 6-4m-9 5h8 M53 10a5 5.5 0 1 0 0 11 5 5.5 0 1 0 0-11
        M63 21V10m0 4q2-5 7-4 M84 10v11m0-6q0-5-5-5-5 0-5 5.5t5 5.5q5 0 5-5
        M91 11v10m0-14v.1" fill="none" stroke="#e9ff99" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>`)
  return {
    input, left: width - badgeWidth - margin, top: height - badgeHeight - margin,
  }
}

function animatedPng(input: Buffer) {
  // libvips exposes the first frame of some APNG files as a regular PNG.
  for (let offset = 8; offset + 12 <= input.length;) {
    const chunkLength = input.readUInt32BE(offset)
    const chunkType = input.toString('ascii', offset + 4, offset + 8)
    if (chunkType === 'acTL') return true
    if (chunkType === 'IDAT' || chunkType === 'IEND') break
    offset += 12 + chunkLength
  }
  return false
}

function inputFormat(input: Buffer) {
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return 'jpeg'
  if (input.subarray(0, 8).equals(PNG_HEADER)) return 'png'
  if (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return undefined
}

@Injectable()
export class ListingMediaService {
  async prepare(manifest: unknown, files: ListingImageUpload[] = []): Promise<ListingImageUpdate | undefined> {
    if (manifest === undefined && files.length === 0) return undefined
    if (!Array.isArray(manifest)) throw new BadRequestException('Укажите порядок фотографий.')
    if (manifest.length > MAX_LISTING_IMAGES || files.length > MAX_LISTING_IMAGES) {
      throw new BadRequestException('К объявлению можно прикрепить до 10 фотографий.')
    }

    const ids = new Set<string>()
    const indices = new Set<number>()
    const order = manifest.map((entry: unknown) => {
      if (typeof entry === 'string') {
        const existingId = uuid(entry, 'Фотография')
        if (ids.has(existingId)) throw new BadRequestException('Фотография указана повторно.')
        ids.add(existingId)
        return existingId
      }
      const index = entry && typeof entry === 'object' && 'fileIndex' in entry && entry.fileIndex
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= files.length || indices.has(index)) {
        throw new BadRequestException('Проверьте порядок и состав фотографий.')
      }
      indices.add(index)
      return index
    })
    if (indices.size !== files.length) throw new BadRequestException('Каждую загруженную фотографию нужно включить в объявление.')

    const update: ListingImageUpdate = []
    for (const entry of order) {
      update.push(typeof entry === 'string' ? entry : await this.process(files[entry].buffer))
    }
    return update
  }

  async save(client: PoolClient, listingId: string, current: ListingImage[], images: ListingImageUpdate) {
    const existingIds = new Set(current.map((image) => image.id))
    const retained: string[] = []
    const positions: number[] = []
    for (const [index, image] of images.entries()) {
      if (typeof image !== 'string') continue
      if (!existingIds.has(image)) throw new BadRequestException('Фотография не принадлежит этому объявлению.')
      retained.push(image)
      positions.push(index + 1)
    }

    await client.query('DELETE FROM listing_images WHERE listing_id = $1 AND NOT (id = ANY($2::uuid[]))', [listingId, retained])
    if (retained.length) {
      await client.query(`
        UPDATE listing_images i SET position = arranged.position
        FROM unnest($2::uuid[], $3::smallint[]) AS arranged(id, position)
        WHERE i.listing_id = $1 AND i.id = arranged.id
      `, [listingId, retained, positions])
    }
    for (const [index, image] of images.entries()) {
      if (typeof image === 'string') continue
      await client.query(`
        INSERT INTO listing_images (listing_id, position, width, height, mime_type, content)
        VALUES ($1, $2, $3, $4, 'image/webp', $5)
      `, [listingId, index + 1, image.width, image.height, image.content])
    }
  }

  private async process(buffer: Buffer): Promise<ProcessedImage> {
    if (buffer.length > MAX_LISTING_IMAGE_BYTES) throw new PayloadTooLargeException('Размер фотографии превышает 8 МБ.')
    try {
      const format = inputFormat(buffer)
      const animated = (format === 'png' && animatedPng(buffer)) ||
        (format === 'webp' && buffer.toString('ascii', 12, 16) === 'VP8X' && (buffer[20] & 2) !== 0)
      if (!format || animated) throw new BadRequestException('Выберите фото JPEG, PNG или WebP без анимации.')
      const source = sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS })
      const info = await source.metadata()
      if (info.format !== format || !info.width || !info.height ||
          info.width * info.height > MAX_INPUT_PIXELS || (info.pages ?? 1) > 1) {
        throw new BadRequestException('Выберите фото JPEG, PNG или WebP без анимации, до 25 мегапикселей.')
      }
      const resized = await source.autoOrient()
        .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .raw().toBuffer({ resolveWithObject: true })
      const { width, height, channels } = resized.info
      const content = await sharp(resized.data, { raw: { width, height, channels } })
        .composite([watermark(width, height)])
        .webp({ quality: 80, alphaQuality: 85 })
        .toBuffer()
      if (content.length > MAX_STORED_BYTES) throw new BadRequestException('Фотография слишком сложная для сохранения.')
      return { content, width, height }
    } catch (error) {
      if (error instanceof BadRequestException) throw error
      throw new BadRequestException('Не удалось прочитать фото. Проверьте формат JPEG, PNG или WebP и размер до 25 мегапикселей.')
    }
  }
}
