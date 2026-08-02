/**
 * Mints a real access token for the local dev admin user, for driving the
 * app in a headless browser without going through the Google OAuth flow.
 * Uses the same JwtService config as AuthModule (same secret, same 15m expiry).
 */
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const user = await prisma.user.findFirst();
  if (!user) throw new Error('No user found locally - sign in via Google SSO once first.');

  const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'super-secret-change-in-production-min-32-chars' });
  const accessToken = jwt.sign({ sub: user.id, email: user.email, orgId: user.orgId }, { expiresIn: '15m' });

  console.log(accessToken);
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
