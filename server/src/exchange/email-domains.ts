import { BadRequestException } from '@nestjs/common'

const publicMailDomains = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'mail.ru',
  'yandex.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'rambler.ru', '163.com', '126.com', 'qq.com', 'sina.com', 'foxmail.com',
])

export function emailDomainKind(email: string): 'CORPORATE' | 'PUBLIC' {
  const match = /^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})$/i.exec(email)
  if (!match || email.length > 254 || /[\p{Cc}\p{Cs}]/u.test(email)) {
    throw new BadRequestException('Укажите рабочую почту, например name@company.example')
  }
  return publicMailDomains.has(match[1].toLowerCase()) ? 'PUBLIC' : 'CORPORATE'
}
