import { Logger } from '@nestjs/common';
import { waitForDatabaseAwake } from './db-wake-retry.util';

describe('waitForDatabaseAwake', () => {
  const connErr = Object.assign(new Error("Can't reach database server at `x:5432`"), { code: 'P1001' });
  let prisma: any;
  let logger: Logger;

  beforeEach(() => {
    jest.useFakeTimers();
    prisma = { $queryRaw: jest.fn() };
    logger = new Logger('test');
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves immediately when the DB probe succeeds on the first try', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

    await waitForDatabaseAwake(prisma, 'test-caller', logger);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff on a connection error, then resolves once the DB comes back', async () => {
    prisma.$queryRaw
      .mockRejectedValueOnce(connErr)
      .mockRejectedValueOnce(connErr)
      .mockResolvedValueOnce([{ '?column?': 1 }]);

    const p = waitForDatabaseAwake(prisma, 'test-caller', logger);
    await jest.runAllTimersAsync();
    await p;

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('throws the last connection error after exhausting all retries', async () => {
    prisma.$queryRaw.mockRejectedValue(connErr);

    const p = waitForDatabaseAwake(prisma, 'test-caller', logger, 3);
    const assertion = expect(p).rejects.toBe(connErr); // attach the rejection handler before advancing timers
    await jest.runAllTimersAsync();
    await assertion;

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on a non-connection error, without retrying', async () => {
    const otherErr = new Error('permission denied for table tools');
    prisma.$queryRaw.mockRejectedValue(otherErr);

    await expect(waitForDatabaseAwake(prisma, 'test-caller', logger)).rejects.toBe(otherErr);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('caps the backoff delay at 6s per step and defaults to 12 attempts (~60s total) rather than giving up too early', async () => {
    // Regression: 6 attempts/30s wasn't always enough for Railway Postgres's real
    // cold-start time in practice (a sign-in attempt exhausted the old 30s budget
    // and failed, then an immediate retry succeeded instantly - Postgres was
    // awake by then). This locks in the wider window and the per-step cap.
    prisma.$queryRaw.mockRejectedValue(connErr);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const p = waitForDatabaseAwake(prisma, 'test-caller', logger, 12);
    const assertion = expect(p).rejects.toBe(connErr);
    await jest.runAllTimersAsync();
    await assertion;

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(12);
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toEqual([2000, 4000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000]);
    expect(delays.reduce((sum: number, d: any) => sum + d, 0)).toBe(60000);
  });
});
