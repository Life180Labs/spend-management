import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Postgres can be asleep independently of this API service (Railway Serverless
 * mode on the DB only) - the first connection attempt after that fails with
 * Prisma's P1001 while it wakes up. Probes the DB with a cheap query and
 * retries with backoff until it succeeds, then returns - callers proceed with
 * their real work only once this resolves. Throws the last error once retries
 * are exhausted (or immediately for any non-connection error), leaving it to
 * the caller to decide what "give up" means for them - a background job might
 * log and skip this run (see scheduler.service.ts), a user-facing request
 * might surface a friendly "try again in a moment" error instead.
 */
export async function waitForDatabaseAwake(
  prisma: PrismaService,
  label: string,
  logger: Logger,
  // ~2+4+6+6+6+6+6+6+6+6+6s = 60s total before giving up. Was 6 attempts/30s,
  // which in practice wasn't always enough for Railway Postgres's real cold-start
  // time (observed: first sign-in attempt exhausted the 30s budget and failed,
  // an immediate second attempt then succeeded instantly - Postgres was awake by
  // then, our window just wasn't long enough). Capping each step at 6s (rather
  // than letting it grow to 10s+) also means more attempts land within the
  // budget, giving a better chance of catching the DB right when it wakes.
  maxAttempts = 12,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err: any) {
      const isConnectionError = err?.code === 'P1001' || /Can't reach database server/i.test(err?.message ?? '');
      if (!isConnectionError) {
        logger.error(`${label}: non-connection database error - ${err.message}`);
        throw err;
      }
      if (attempt === maxAttempts) {
        logger.error(`${label}: database still unreachable after ${maxAttempts} attempts`);
        throw err;
      }
      const delayMs = Math.min(attempt * 2000, 6000);
      logger.warn(`${label}: database unreachable (attempt ${attempt}/${maxAttempts}), likely waking from Serverless sleep - retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
