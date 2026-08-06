import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService.loginOrCreateGoogleUser', () => {
  let prisma: any;
  let jwt: any;
  let config: any;
  let service: AuthService;
  let allowedSsoEmails: string;

  const googleUser = { email: 'a@b.com', name: 'A B', googleId: 'g1' };

  beforeEach(() => {
    jest.useFakeTimers();
    allowedSsoEmails = ''; // no allowlist by default - anyone can sign in
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      user: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      organization: { findFirst: jest.fn() },
      department: { findFirst: jest.fn(), create: jest.fn() },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
    };
    jwt = { sign: jest.fn().mockReturnValue('signed-token') };
    config = { get: jest.fn((key: string, def?: any) => (key === 'ALLOWED_SSO_EMAILS' ? allowedSsoEmails : def)) };
    service = new AuthService(prisma, jwt, config);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects an email not on the allowlist WITHOUT ever touching the database', async () => {
    allowedSsoEmails = 'only-this@b.com';

    await expect(service.loginOrCreateGoogleUser(googleUser)).rejects.toThrow(UnauthorizedException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('logs in an existing user and issues tokens', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: googleUser.email, orgId: 'org1' });

    const tokens = await service.loginOrCreateGoogleUser(googleUser);

    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { lastLoginAt: expect.any(Date) } });
    expect(tokens).toEqual({ accessToken: 'signed-token', refreshToken: 'signed-token' });
  });

  it('signs each refresh token with a unique jti, so two logins in the same second never collide on tokenHash', async () => {
    // Regression test: without a per-call jti, two issueTokens() calls within the
    // same second (JWT's iat has 1s resolution) sign byte-identical refresh JWTs -
    // same payload, same iat/exp - which then hash to the same tokenHash and crash
    // on RefreshToken's unique constraint. Realistic triggers: a double-clicked
    // login button, a duplicated OAuth callback render, two tabs signing in at once.
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: googleUser.email, orgId: 'org1' });

    await service.loginOrCreateGoogleUser(googleUser);
    await service.loginOrCreateGoogleUser(googleUser);

    // jwt.sign is called twice per issueTokens (access token, then refresh token) -
    // the refresh token is always the 2nd call of each pair.
    const firstRefreshPayload = jwt.sign.mock.calls[1][0];
    const secondRefreshPayload = jwt.sign.mock.calls[3][0];

    expect(firstRefreshPayload.jti).toEqual(expect.any(String));
    expect(secondRefreshPayload.jti).toEqual(expect.any(String));
    expect(firstRefreshPayload.jti).not.toBe(secondRefreshPayload.jti);
  });

  it('auto-provisions a new user into the first org when no existing user matches', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.organization.findFirst.mockResolvedValue({ id: 'org1', createdAt: new Date() });
    prisma.department.findFirst.mockResolvedValue({ id: 'dept1' });
    prisma.user.create.mockResolvedValue({ id: 'u-new', email: googleUser.email, orgId: 'org1' });

    await service.loginOrCreateGoogleUser(googleUser);

    expect(prisma.user.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ orgId: 'org1', email: googleUser.email }),
    }));
  });

  it('throws if no organization exists to auto-provision into', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.organization.findFirst.mockResolvedValue(null);

    await expect(service.loginOrCreateGoogleUser(googleUser)).rejects.toThrow('No organization found');
  });

  describe('Postgres Serverless wake-up handling', () => {
    const connErr = Object.assign(new Error("Can't reach database server at `x:5432`"), { code: 'P1001' });

    it('retries the DB probe with backoff, then proceeds normally once Postgres wakes up', async () => {
      prisma.$queryRaw
        .mockRejectedValueOnce(connErr)
        .mockRejectedValueOnce(connErr)
        .mockResolvedValueOnce([{ '?column?': 1 }]);
      prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: googleUser.email, orgId: 'org1' });

      const run = service.loginOrCreateGoogleUser(googleUser);
      await jest.runAllTimersAsync();
      const tokens = await run;

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(tokens).toEqual({ accessToken: 'signed-token', refreshToken: 'signed-token' });
    });

    it('surfaces a friendly error (not a raw Prisma error) once retries are exhausted', async () => {
      prisma.$queryRaw.mockRejectedValue(connErr);

      const run = service.loginOrCreateGoogleUser(googleUser);
      const assertion = expect(run).rejects.toThrow('Sign-in is temporarily unavailable - please try again in a moment.');
      await jest.runAllTimersAsync();
      await assertion;

      expect(prisma.user.findFirst).not.toHaveBeenCalled(); // never got to the real lookup
    });
  });
});
