import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChallengeDto, CredentialsDto, LoginDto, PasswordDto, ProfileDto, RegisterDto, VerifyDto } from './auth.dto';
import { AuthService, COOKIE_NAME, SESSION_TTL, SessionResult, sessionCookie } from './auth.service';

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

  @Post('register')
  register(@Body() input: RegisterDto, @Req() request: Request) {
    return this.auth.register(input, ip(request));
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
    return { user: await this.auth.resolve(request) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request);
    response.clearCookie(COOKIE_NAME, sessionCookie());
  }

  @Patch('profile')
  async profile(@Body() input: ProfileDto, @Req() request: Request) {
    return { user: await this.auth.updateProfile(request, input) };
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
