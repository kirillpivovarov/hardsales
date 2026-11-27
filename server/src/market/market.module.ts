import { MatchingModule } from '../matching/matching.module'
import { ActualityModule } from '../exchange/actuality.module'
import { TrustModule } from '../exchange/trust.module'
import { DisclosuresModule } from '../exchange/disclosures.module'
import { Module } from '@nestjs/common'
import { AdminController, AgentModerationController } from './admin.controller'
import { AdminService } from './admin.service'
import { CatalogService } from './catalog.service'
import { ChatsService } from './chats.service'
import { ListingMediaService } from './listing-media.service'
import { ListingPublication } from './listing-publication'
import { ListingStaffGuard, ListingMemberGuard, ListingUploadCapacity } from './listing-upload'
import { ChatsController, MarketController } from './market.controller'

@Module({
  imports: [ActualityModule, TrustModule, DisclosuresModule, MatchingModule],
  controllers: [MarketController, ChatsController, AdminController, AgentModerationController],
  providers: [
    CatalogService, ChatsService, AdminService, ListingMediaService, ListingPublication,
    ListingStaffGuard, ListingMemberGuard, ListingUploadCapacity,
  ],
})
export class MarketModule {}
