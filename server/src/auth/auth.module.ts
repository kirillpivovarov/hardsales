import { Global, Module } from '@nestjs/common';
import { AuthController, ModeratorAccountsController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';

@Global()
@Module({
  controllers: [AuthController, ModeratorAccountsController],
  providers: [AuthService, MailService],
  exports: [AuthService],
})
export class AuthModule {}
