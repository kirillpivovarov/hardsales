import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'

export const documentLimit = 10 * 1024 * 1024
export type DocumentUpload = { originalname: string; mimetype: string; buffer: Buffer }

export function documentFile(file?: DocumentUpload) {
  if (!file?.buffer?.length) throw new BadRequestException('Приложите файл документа')
  const data = file.buffer
  if (data.length > documentLimit) throw new PayloadTooLargeException('Размер файла не должен превышать 10 МиБ')
  const text = (start: number, end: number) => data.toString('latin1', start, end)
  let mime: string | undefined
  if (/^%PDF-[12]\.\d/.test(text(0, 8))) mime = 'application/pdf'
  else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mime = 'image/jpeg'
  else if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png'
  else if (data.length >= 16 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' && /^VP8[ LX]$/.test(text(12, 16))) mime = 'image/webp'
  else if (data.length >= 16 && text(4, 8) === 'ftyp' && /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV)$/.test(text(8, 12))
    && data.readUInt32BE(0) >= 16 && data.readUInt32BE(0) <= data.length) mime = 'video/mp4'
  if (!mime || (file.mimetype && file.mimetype !== mime && file.mimetype !== 'application/octet-stream')) {
    throw new BadRequestException('Тип файла не поддерживается')
  }
  // Multer reads ordinary browser multipart filenames as Latin-1 by default.
  const decoded = Buffer.from(file.originalname ?? '', 'latin1').toString('utf8')
  const original = decoded.includes('\uFFFD') ? file.originalname ?? '' : decoded
  const fileName = Array.from(original.replace(/[\p{Cc}\p{Cf}\\/]/gu, '_').trim()).slice(0, 200).join('') || 'document'
  return { fileName, mime, buffer: data }
}
