// One password rule for everyone with a password (buyers and staff), above SuperTokens' default
// (8 characters): at least 10, with a letter and a digit. Applies at signup, at reset, in the seed
// scripts and when an admin sets someone's first password. A leaf file on purpose: both
// core/supertokens.ts and the identity module need it, and they cannot import each other.
export const MIN_PASSWORD_LENGTH = 10;

export function validatePassword(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  if (value.length > 100) {
    return 'Password must be at most 100 characters long';
  }
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
    return 'Password must contain at least one letter and one number';
  }
  return undefined;
}
