import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import { hasExternalLinks } from '../contact-guard/detect'
import { documentFile, documentLimit, type DocumentUpload } from '../exchange/trust-files'
import { str } from '../market/market.inputs'

export function disputeText(input: unknown, label: string, min: number, max: number) {
  const text = str(input, label, min, max)
  // Attachments may contain evidence such as an email address or telephone number.
  if (hasExternalLinks(text)) throw new BadRequestException('Уберите внешнюю ссылку и приложите материалы спора')
  return text
}

export function disputeFile(file?: DocumentUpload) {
  if (!file) return null
  if (file.buffer.length > documentLimit) throw new PayloadTooLargeException('Размер файла не должен превышать 10 МиБ')
  const prefix = file.buffer.subarray(0, 16).toString('latin1')
  if (/^%PDF-|^\xFF\xD8\xFF|^\x89PNG|^RIFF/.test(prefix)) {
    const document = documentFile(file)
    if (document.mime === 'video/mp4') throw new BadRequestException('Тип файла не поддерживается')
    return document
  }
  if (file.mimetype !== 'text/plain' && file.mimetype !== 'application/octet-stream') {
    throw new BadRequestException('Тип файла не поддерживается')
  }
  let value: string
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer) }
  catch { throw new BadRequestException('Приложите текст в кодировке UTF-8') }
  if (!value.trim() || /[^\t\n\r\P{Cc}]/u.test(value)) throw new BadRequestException('Тип файла не поддерживается')
  disputeText(value, 'Текст файла', 1, documentLimit)
  const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8')
  const original = decoded.includes('\uFFFD') ? file.originalname : decoded
  const fileName = Array.from(original.replace(/[\p{Cc}\p{Cf}\\/]/gu, '_').trim()).slice(0, 200).join('') || 'evidence.txt'
  return { fileName, mime: 'text/plain', buffer: file.buffer }
}
