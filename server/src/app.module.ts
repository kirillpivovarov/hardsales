import { Controller, Get, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { MarketModule } from './market/market.module';
import { PlatformModule } from './exchange/platform.module';
import { DisclosuresModule } from './exchange/disclosures.module';
import { RepresentationModule } from './exchange/representation.module';
import { ModelsModule } from './models/models.module';

@Controller('health')
class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }
}

@Module({
  imports: [DatabaseModule, PlatformModule, AuthModule, MarketModule, DisclosuresModule, RepresentationModule, ModelsModule],
  controllers: [HealthController],
})
export class AppModule {}
