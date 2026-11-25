import { Module } from '@nestjs/common'
import { AdminController, AgentModerationController } from './admin.controller'
import { AdminService } from './admin.service'
import { CatalogService } from './catalog.service'
import { ChatsService } from './chats.service'
import { ListingMediaService } from './listing-media.service'
import { ListingAdminGuard, ListingMemberGuard, ListingUploadCapacity } from './listing-upload'
import { ChatsController, MarketController } from './market.controller'

@Module({
  controllers: [MarketController, ChatsController, AdminController, AgentModerationController],
  providers: [
    CatalogService, ChatsService, AdminService, ListingMediaService,
    ListingAdminGuard, ListingMemberGuard, ListingUploadCapacity,
  ],
})
export class MarketModule {}
