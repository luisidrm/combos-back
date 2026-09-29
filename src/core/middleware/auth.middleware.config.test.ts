import { describe, expect, it, vi } from 'vitest';

// verifySession()'s options are the one thing the auth.middleware.test.ts
// fakes can't exercise, since they stand in for what SuperTokens hands back
// AFTER verification, not for how it verifies. `checkDatabase: true` is what
// makes Session.revokeAllSessionsForUser (called on password reset) take
// effect immediately rather than only once the access token's own expiry
// passes — without it, a revoked session's token still works until then, as
// found by hand against a live core. This pins the configuration so a future
// edit can't silently drop it and reopen that gap.
const verifySession = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock('supertokens-node/recipe/session/framework/express/index.js', () => ({ verifySession }));
vi.mock('../queue.js', () => ({ redisConnection: {} }));

describe('auth middleware: session verification config', () => {
  it('asks SuperTokens to check the database on every verification, required or optional', async () => {
    await import('./auth.middleware.js');

    expect(verifySession).toHaveBeenCalledWith(expect.objectContaining({ checkDatabase: true }));
    expect(verifySession).toHaveBeenCalledWith(expect.objectContaining({ sessionRequired: false, checkDatabase: true }));
    expect(verifySession).toHaveBeenCalledTimes(2);
  });
});
