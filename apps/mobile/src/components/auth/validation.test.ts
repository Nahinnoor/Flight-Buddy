import { describe, expect, it } from 'vitest';

import {
  isClean,
  MIN_PASSWORD_LENGTH,
  validateCurrentPassword,
  validateEmail,
  validateName,
  validateNewPassword,
} from './validation';

describe('validateEmail', () => {
  it('accepts an ordinary address', () => {
    expect(validateEmail('sam@example.com')).toBeUndefined();
  });

  it('trims before judging', () => {
    expect(validateEmail('  sam@example.com  ')).toBeUndefined();
  });

  it('rejects the typos it exists for', () => {
    expect(validateEmail('')).toBeDefined();
    expect(validateEmail('sam@')).toBeDefined();
    expect(validateEmail('sam example.com')).toBeDefined();
    expect(validateEmail('sam@example')).toBeDefined();
  });

  it('does not try to out-guess the mail server on legal oddities', () => {
    expect(validateEmail("o'brien+flights@sub.domain.travel")).toBeUndefined();
  });
});

describe('password rules', () => {
  it('asks only that a current password is present', () => {
    expect(validateCurrentPassword('x')).toBeUndefined();
    expect(validateCurrentPassword('')).toBeDefined();
  });

  it('enforces the minimum length on a new password', () => {
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeUndefined();
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBeDefined();
  });
});

describe('validateName', () => {
  it('rejects whitespace, because display_name is NOT NULL', () => {
    expect(validateName('   ')).toBeDefined();
    expect(validateName('Sam')).toBeUndefined();
  });
});

describe('isClean', () => {
  it('ignores keys explicitly set to undefined', () => {
    expect(isClean({ email: undefined, password: undefined })).toBe(true);
    expect(isClean({ email: 'nope' })).toBe(false);
  });
});
