import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { waitForDatabaseAwake } from '../prisma/db-wake-retry.util';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

// Thrown only for a connection-unreachable DB, never for a real failure
// (wrong credentials, unauthorized email, etc.) - callers use this to decide
// "keep the user waiting and retry" vs "this is a genuine, final error."
export class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database is temporarily unreachable');
  }
}

interface PendingGoogleProfile {
  type: 'pending_google_profile'; // distinguishes this from a real access/refresh token payload
  email: string;
  name: string;
  googleId: string;
  picture?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) { }

  async signup(dto: SignupDto) {
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already registered');

    // Create org + user atomically
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const initials = dto.name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

    const org = await this.prisma.organization.create({
      data: {
        name: dto.orgName || `${dto.name}'s Workspace`,
        slug: this.slugify(dto.orgName || dto.name),
        currency: 'USD',
        users: {
          create: {
            email: dto.email,
            name: dto.name,
            initials,
            passwordHash,
            memberships: {
              create: {
                role: 'ADMIN',
                isPrimary: true,
                department: {
                  create: {
                    name: 'Engineering',
                    code: 'ENG',
                    org: { connect: { id: undefined } }, // connected via org creation
                  },
                },
              },
            },
          },
        },
      },
      include: { users: true },
    });

    const user = org.users[0];
    return this.issueTokens(user.id, user.email, user.orgId);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, isActive: true, deletedAt: null },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueTokens(user.id, user.email, user.orgId);
  }

  async refresh(token: string) {
    const record = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: await this.hashToken(token), revokedAt: null },
      include: { user: true },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    return this.issueTokens(record.user.id, record.user.email, record.user.orgId);
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // One-shot: probes the DB exactly once (no inline retry) and either
  // completes the login or throws DatabaseUnavailableError. Retrying across
  // multiple *separate* short requests - not one held-open request - is the
  // caller's job now (see googleCallback/completeGoogleSignIn in
  // auth.controller.ts): a single HTTP request retried for up to a minute is
  // fragile against any upstream proxy/gateway timeout shorter than that,
  // which would kill the connection out from under a long inline retry
  // regardless of what backoff we pick. Short, repeated, cheap polls have no
  // such ceiling.
  async loginOrCreateGoogleUser(googleUser: {
    email: string;
    name: string;
    googleId: string;
    picture?: string;
  }) {
    // Allowlist check - pure config, no DB needed, so this runs before we
    // even touch Postgres and fails fast for a genuinely unauthorized email.
    const raw = this.config.get<string>('ALLOWED_SSO_EMAILS', '');
    const allowed = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(googleUser.email.toLowerCase())) {
      throw new UnauthorizedException(`${googleUser.email} is not authorized to access this workspace`);
    }

    try {
      await waitForDatabaseAwake(this.prisma, 'Google sign-in', this.logger, 1);
    } catch {
      throw new DatabaseUnavailableError();
    }

    // Find existing user by email
    let user = await this.prisma.user.findFirst({
      where: { email: googleUser.email, deletedAt: null },
    });

    if (!user) {
      // Auto-provision: add to the first org in the system
      const org = await this.prisma.organization.findFirst({
        orderBy: { createdAt: 'asc' },
      });
      if (!org) throw new Error('No organization found - run the seed first');

      const initials = googleUser.name
        .split(' ')
        .map((w: string) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);

      // Find or create a department for the org
      let dept = await this.prisma.department.findFirst({
        where: { orgId: org.id, deletedAt: null },
      });
      if (!dept) {
        dept = await this.prisma.department.create({
          data: { orgId: org.id, name: 'General', code: 'GEN' },
        });
      }

      user = await this.prisma.user.create({
        data: {
          orgId: org.id,
          email: googleUser.email,
          name: googleUser.name,
          initials,
          passwordHash: '',
          isActive: true,
          memberships: {
            create: {
              role: 'ADMIN',
              isPrimary: true,
              departmentId: dept.id,
            },
          },
        },
      });
    } else {
      // Update last login
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    }

    return this.issueTokens(user.id, user.email, user.orgId);
  }

  // Carries a Google-verified profile across the "DB was unreachable" gap -
  // Google's own auth code is single-use and already consumed by this point,
  // so a retry can't re-run the OAuth handshake; this lets the frontend poll
  // completeGoogleSignIn() repeatedly without the user re-clicking "Continue
  // with Google." 15m is a safety net, not a retry budget - long enough to
  // cover a slow Postgres wake, short enough that a token found in a browser
  // history/URL bar isn't usable for long (it carries no secret, just
  // Google-proven identity claims, but still shouldn't linger indefinitely).
  signPendingGoogleProfile(googleUser: { email: string; name: string; googleId: string; picture?: string }): string {
    const payload: PendingGoogleProfile = {
      type: 'pending_google_profile',
      email: googleUser.email,
      name: googleUser.name,
      googleId: googleUser.googleId,
      picture: googleUser.picture,
    };
    return this.jwt.sign(payload, { expiresIn: '15m' });
  }

  private verifyPendingGoogleProfile(token: string): PendingGoogleProfile {
    let payload: any;
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('This sign-in attempt has expired - please try signing in again.');
    }
    if (payload?.type !== 'pending_google_profile') {
      throw new UnauthorizedException('Invalid sign-in token');
    }
    return payload;
  }

  // Called by the frontend's polling loop (see the /login page's "Finishing
  // sign-in..." state) - { ready: false } means "still waiting on Postgres,
  // keep polling," never an HTTP error, so the frontend never has to treat a
  // transient DB gap as a failure. A genuinely expired/invalid token, or any
  // non-connection error, still throws - those are real, final failures.
  async completeGoogleSignIn(token: string): Promise<{ ready: false } | { ready: true; accessToken: string; refreshToken: string }> {
    const profile = this.verifyPendingGoogleProfile(token);
    try {
      const tokens = await this.loginOrCreateGoogleUser(profile);
      return { ready: true, ...tokens };
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) return { ready: false };
      throw err;
    }
  }

  private async issueTokens(userId: string, email: string, orgId: string) {
    const payload = { sub: userId, email, orgId };
    const accessToken = this.jwt.sign(payload);

    const refreshExpiry = new Date();
    refreshExpiry.setDate(refreshExpiry.getDate() + 30);

    // jti (random per call) - without it, two calls for the same user within
    // the same second (JWT's iat has 1s resolution) sign byte-identical tokens,
    // whose identical SHA-256 hash then violates tokenHash's unique constraint
    // (e.g. a double-submitted OAuth callback, a double-clicked login button,
    // two tabs signing in at once - all realistic, not just a testing fluke).
    const rawRefresh = this.jwt.sign({ ...payload, jti: randomUUID() }, {
      secret: this.config.get('JWT_REFRESH_SECRET', 'refresh-secret'),
      expiresIn: '30d',
    });

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: await this.hashToken(rawRefresh),
        expiresAt: refreshExpiry,
      },
    });

    return { accessToken, refreshToken: rawRefresh };
  }

  private async hashToken(token: string): Promise<string> {
    // Simple hash - not bcrypt (bcrypt is too slow for token lookup)
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') +
      '-' +
      Math.random().toString(36).slice(2, 6)
    );
  }
}
