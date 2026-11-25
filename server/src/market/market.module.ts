import { Module } from '@nestjs/common'
import { AdminController, AgentModerationController } from './admin.controller'
import { AdminService } from './admin.service'
import { CatalogService } from './catalog.service'
import { ChatsService } from './chats.service'
import { ChatsController, MarketController } from './market.controller'

@Module({
  controllers: [MarketController, ChatsController, AdminController, AgentModerationController],
  providers: [CatalogService, ChatsService, AdminService],
})
export class MarketModule {}
