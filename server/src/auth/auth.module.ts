import { Global, Module } from '@nestjs/common';
import { AuthController, ModeratorAccountsController } from './auth.controller';
import { AuthService } from './auth.service';
import { InvitesService } from '../exchange/invites.service';
import { OnboardingController } from '../exchange/onboarding.controller';
import { OnboardingService } from '../exchange/onboarding.service';

@Global()
@Module({
  controllers: [AuthController, ModeratorAccountsController, OnboardingController],
  providers: [AuthService, InvitesService, OnboardingService],
  exports: [AuthService, OnboardingService],
})
export class AuthModule {}
