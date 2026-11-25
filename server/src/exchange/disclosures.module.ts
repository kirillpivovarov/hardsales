import { Global, Module } from '@nestjs/common'
import { DisclosuresController } from './disclosures.controller'
import { DisclosuresService } from './disclosures.service'

@Global()
@Module({ controllers: [DisclosuresController], providers: [DisclosuresService], exports: [DisclosuresService] })
export class DisclosuresModule {}
