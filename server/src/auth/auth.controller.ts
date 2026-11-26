import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AcceptPolicyDto, ChallengeDto, CreateModeratorDto, CredentialsDto, LoginDto, PasswordDto, ProfileDto, RegisterDto, VerifyDto } from './auth.dto';
import { AuthService, COOKIE_NAME, SESSION_TTL, SessionResult, sessionCookie } from './auth.service';
import { consentRequest } from '../privacy/policy';

function setSession(response: Response, result: SessionResult) {
  response.cookie(COOKIE_NAME, result.token, { ...sessionCookie(), maxAge: SESSION_TTL * 1_000 });
  return { user: result.user };
}

function ip(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('captcha')
  captcha(@Req() request: Request) {
    return this.auth.registrationCaptcha(ip(request));
  }

  @Post('register')
  register(@Body() input: RegisterDto, @Req() request: Request) {
    return this.auth.register(input, ip(request), consentRequest(request));
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() input: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(input, ip(request));
    return 'token' in result ? setSession(response, result) : result;
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body() input: VerifyDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return setSession(response, await this.auth.verify(input.challengeId, input.code, ip(request)));
  }

  @Post('resend')
  @HttpCode(200)
  resend(@Body() input: ChallengeDto, @Req() request: Request) {
    return this.auth.resend(input.challengeId, ip(request));
  }

  @Get('me')
  async me(@Req() request: Request) {
    const [user, registrationMode, policy] = await Promise.all([
      this.auth.resolve(request), this.auth.registrationMode(), this.auth.privacyStatus(),
    ]);
    return {
      user, ...policy, ...(registrationMode === 'INVITE' && { registrationMode }),
      pdConsentRequired: user?.pdConsentRequired ?? false, infoEmailConsent: user?.infoEmailConsent ?? false,
    };
  }

  @Post('consent')
  @HttpCode(200)
  async consent(@Req() request: Request, @Body() input: AcceptPolicyDto) {
    return { user: await this.auth.acceptPolicy(request, input, consentRequest(request)) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request);
    response.clearCookie(COOKIE_NAME, sessionCookie());
  }

  @Patch('profile')
  async profile(@Body() input: ProfileDto, @Req() request: Request) {
    return { user: await this.auth.updateProfile(request, input, consentRequest(request)) };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Body() input: PasswordDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return setSession(response, await this.auth.changeCredentials(request, input));
  }

  @Patch('credentials')
  async changeCredentials(@Body() input: CredentialsDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return setSession(response, await this.auth.changeCredentials(request, input));
  }
}

@Controller('admin/moderators')
export class ModeratorAccountsController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  async create(@Req() request: Request, @Body() input: CreateModeratorDto) {
    return { user: await this.auth.createModerator(request, input) };
  }
}
