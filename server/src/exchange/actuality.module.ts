import { Global, Module } from '@nestjs/common'
import { MatchingModule } from '../matching/matching.module'
import { ActualityController } from './actuality.controller'
import { ActualityJobs } from './actuality.jobs'
import { ActualityService } from './actuality.service'
import { TrustModule } from './trust.module'

@Global()
@Module({
  imports: [MatchingModule, TrustModule], controllers: [ActualityController],
  providers: [ActualityService, ActualityJobs], exports: [ActualityService],
})
export class ActualityModule {}
