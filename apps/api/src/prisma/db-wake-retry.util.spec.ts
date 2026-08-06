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
});
