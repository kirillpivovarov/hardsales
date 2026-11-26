import { Controller, Get, Global, Module, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from '../auth/auth.service'
import { ContactGuardService } from './contact-guard.service'

@Controller('admin/contact-blocks')
class ContactBlocksController {
  constructor(private readonly auth: AuthService, private readonly guard: ContactGuardService) {}

  @Get()
  async history(@Req() request: Request, @Query() query: Record<string, unknown>) {
    return this.guard.history(await this.auth.admin(request), query)
  }
}

@Global()
@Module({ controllers: [ContactBlocksController], providers: [ContactGuardService], exports: [ContactGuardService] })
export class ContactGuardModule {}
