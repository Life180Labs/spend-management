import {
  Controller, Post, Body, Req, UseGuards, HttpCode,
  Get, Res,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AuthService, DatabaseUnavailableError } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { CompleteGoogleSignInDto } from './dto/complete-google-signin.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private config: ConfigService,
  ) { }

  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  logout(@Req() req: any) {
    return this.auth.logout(req.user.sub);
  }

  // ── Google OAuth ──────────────────────────────────────────────
  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleLogin() {
    // Passport redirects to Google - nothing to do here
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Req() req: any, @Res() res: Response) {
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    try {
      const tokens = await this.auth.loginOrCreateGoogleUser(req.user);
      res.redirect(
        `${frontendUrl}/callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`,
      );
    } catch (err: any) {
      if (err instanceof DatabaseUnavailableError) {
        // Google's auth code is single-use and already spent - can't retry the
        // OAuth handshake itself. Hand the browser a pending-sign-in token
        // instead and send it back to /login, which shows "Finishing sign-in…"
        // and polls completeGoogleSignIn() until Postgres is reachable - no
        // error is ever shown to the user for this case.
        const pending = this.auth.signPendingGoogleProfile(req.user);
        res.redirect(`${frontendUrl}/login?pending=${pending}`);
        return;
      }
      const msg = encodeURIComponent(err.message || 'Access denied');
      res.redirect(`${frontendUrl}/login?error=${msg}`);
    }
  }

  @Post('google/complete')
  @HttpCode(200)
  completeGoogleSignIn(@Body() dto: CompleteGoogleSignInDto) {
    return this.auth.completeGoogleSignIn(dto.token);
  }
}
