import { Global, Module } from '@nestjs/common';
import { AuthController, ModeratorAccountsController, TradeSidesController } from './auth.controller';
import { AuthService } from './auth.service';
import { InvitesService } from '../exchange/invites.service';
import { OnboardingController } from '../exchange/onboarding.controller';
import { OnboardingService } from '../exchange/onboarding.service';
import { PrivacyController } from '../privacy/privacy.controller';
import { PrivacyService } from '../privacy/privacy.service';

@Global()
@Module({
  controllers: [AuthController, ModeratorAccountsController, OnboardingController, PrivacyController, TradeSidesController],
  providers: [AuthService, InvitesService, OnboardingService, PrivacyService],
  exports: [AuthService, OnboardingService],
})
export class AuthModule {}
