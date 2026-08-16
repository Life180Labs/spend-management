import { UnauthorizedException } from '@nestjs/common';
import { AuthService, DatabaseUnavailableError } from './auth.service';

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

    // No inline retry anymore - loginOrCreateGoogleUser probes exactly once and
    // throws immediately on a connection error. Retrying across multiple SHORT,
    // separate requests (not one held-open request) is now the caller's job -
    // see completeGoogleSignIn() below and auth.controller.ts's googleCallback -
    // because a single request retried for up to a minute is fragile against
    // any upstream proxy/gateway timeout shorter than that.
    it('throws DatabaseUnavailableError immediately on a connection error, without retrying inline', async () => {
      prisma.$queryRaw.mockRejectedValue(connErr);

      await expect(service.loginOrCreateGoogleUser(googleUser)).rejects.toThrow(DatabaseUnavailableError);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('succeeds normally when the DB probe succeeds on the first try', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: googleUser.email, orgId: 'org1' });

      const tokens = await service.loginOrCreateGoogleUser(googleUser);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tokens).toEqual({ accessToken: 'signed-token', refreshToken: 'signed-token' });
    });
  });

  describe('pending Google sign-in (the DB-unavailable retry path)', () => {
    const connErr = Object.assign(new Error("Can't reach database server at `x:5432`"), { code: 'P1001' });
    const pendingPayload = { type: 'pending_google_profile', ...googleUser };

    it('signs a short-lived token carrying the Google profile', () => {
      service.signPendingGoogleProfile(googleUser);

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pending_google_profile', email: googleUser.email, googleId: googleUser.googleId }),
        { expiresIn: '15m' },
      );
    });

    it('returns { ready: false } - never a thrown error - while the DB is still unreachable, so the frontend never shows an error for this case', async () => {
      jwt.verify = jest.fn().mockReturnValue(pendingPayload);
      prisma.$queryRaw.mockRejectedValue(connErr);

      const result = await service.completeGoogleSignIn('pending-token');

      expect(result).toEqual({ ready: false });
    });

    it('returns real tokens once Postgres is reachable again', async () => {
      jwt.verify = jest.fn().mockReturnValue(pendingPayload);
      prisma.user.findFirst.mockResolvedValue({ id: 'u1', email: googleUser.email, orgId: 'org1' });

      const result = await service.completeGoogleSignIn('pending-token');

      expect(result).toEqual({ ready: true, accessToken: 'signed-token', refreshToken: 'signed-token' });
    });

    it('throws a real, final error for an expired/invalid pending token, rather than polling forever', async () => {
      jwt.verify = jest.fn().mockImplementation(() => { throw new Error('jwt expired'); });

      await expect(service.completeGoogleSignIn('bad-token')).rejects.toThrow('This sign-in attempt has expired');
    });

    it('throws if the token decodes but is not actually a pending-profile token (e.g. a real access token passed here by mistake)', async () => {
      jwt.verify = jest.fn().mockReturnValue({ sub: 'someone', email: 'x@y.com' });

      await expect(service.completeGoogleSignIn('not-a-pending-token')).rejects.toThrow('Invalid sign-in token');
    });
  });
});
