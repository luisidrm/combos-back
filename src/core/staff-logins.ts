import { randomBytes } from 'node:crypto';
import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import EmailVerification from 'supertokens-node/recipe/emailverification';
import Session from 'supertokens-node/recipe/session';
import { InternalError } from './errors.js';

// What the team screen needs from SuperTokens: creating a login for a staff member or courier,
// sending them the link to choose their own password, and ending their sessions when their role
// or access changes. Kept apart from core/supertokens.ts (the recipe setup) because that file
// imports the identity module, and the identity module needs these functions.
//
// Everything runs in SuperTokens' one built-in tenant; a store is modelled in our own database.
const SUPERTOKENS_TENANT = 'public';

export interface LoginRef {
  /** SuperTokens' user id, stored on our `users` row. */
  userId: string;
  /** False when the person already had a login (the same email is one login across stores). */
  created: boolean;
}

// A password nobody sees: the person sets their own through the invite link.
export function randomPassword(): string {
  // 18 random bytes as base64url, plus a guaranteed letter and digit, always passes the policy.
  return `${randomBytes(18).toString('base64url')}aA1`;
}

// Creates the email + password login, or finds the existing one. A staff member is vouched for by
// the admin who adds them, so their email counts as confirmed (no inbox round trip).
export async function ensureLogin(email: string, password: string): Promise<LoginRef> {
  const signUp = await EmailPassword.signUp(SUPERTOKENS_TENANT, email, password);
  if (signUp.status === 'OK') {
    const token = await EmailVerification.createEmailVerificationToken(SUPERTOKENS_TENANT, signUp.recipeUserId, email);
    if (token.status === 'OK') {
      await EmailVerification.verifyEmailUsingToken(SUPERTOKENS_TENANT, token.token);
    }
    return { userId: signUp.user.id, created: true };
  }
  const existing = await supertokens.listUsersByAccountInfo(SUPERTOKENS_TENANT, { email });
  const login = existing.find((candidate) => candidate.loginMethods.some((method) => method.recipeId === 'emailpassword'));
  if (!login) {
    throw new InternalError('Could not create or find the login for this email');
  }
  return { userId: login.id, created: false };
}

// Emails the person a link to choose their password. It is SuperTokens' password reset link (sent
// through our own notifications, like every other message) and is valid for about an hour.
export async function sendPasswordLink(userId: string, email: string): Promise<void> {
  const result = await EmailPassword.sendResetPasswordEmail(SUPERTOKENS_TENANT, userId, email);
  if (result.status !== 'OK') {
    throw new InternalError('Could not send the password link');
  }
}

// The role rides in the session token, so ending the sessions makes a role change or a disabled
// account take effect immediately instead of when the token expires.
export async function endSessions(userId: string): Promise<void> {
  await Session.revokeAllSessionsForUser(userId);
}
