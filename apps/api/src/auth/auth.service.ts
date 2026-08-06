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

  async loginOrCreateGoogleUser(googleUser: {
    email: string;
    name: string;
    googleId: string;
    picture?: string;
  }) {
    // Allowlist check - pure config, no DB needed, so this runs before we
    // even wait on Postgres and fails fast for a genuinely unauthorized email.
    const raw = this.config.get<string>('ALLOWED_SSO_EMAILS', '');
    const allowed = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(googleUser.email.toLowerCase())) {
      throw new UnauthorizedException(`${googleUser.email} is not authorized to access this workspace`);
    }

    // Postgres can be asleep (Railway Serverless mode on the DB) when this
    // fires - unlike the background scheduler jobs, someone is actively
    // waiting on this request, so a still-unreachable DB becomes a friendly
    // error instead of a raw Prisma stack trace on the login page.
    try {
      await waitForDatabaseAwake(this.prisma, 'Google sign-in', this.logger);
    } catch {
      throw new Error('Sign-in is temporarily unavailable - please try again in a moment.');
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
