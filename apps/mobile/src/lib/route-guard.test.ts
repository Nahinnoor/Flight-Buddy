import { describe, expect, it } from 'vitest';

import { linkExchangeFor, routeFor, type GuardState } from './route-guard';

const base: GuardState = { isLoading: false, signedIn: false, isRecovering: false, segments: [] };
const at = (...segments: string[]) => segments;

describe('routeFor', () => {
  it('decides nothing while the stored session is loading', () => {
    expect(routeFor({ ...base, isLoading: true, segments: at('(app)') })).toBeNull();
    expect(routeFor({ ...base, isLoading: true, signedIn: true, segments: at('(auth)', 'welcome') })).toBeNull();
  });

  describe('signed out', () => {
    it('sends the app half to the welcome screen', () => {
      expect(routeFor({ ...base, segments: at('(app)') })).toBe('/welcome');
      expect(routeFor({ ...base, segments: at('(app)', 'add-flight') })).toBe('/welcome');
      expect(routeFor({ ...base, segments: at() })).toBe('/welcome');
    });

    it.each(['groups', 'profile', 'settings'])('sends the %s tab to the welcome screen', (tab) => {
      expect(routeFor({ ...base, segments: at('(app)', '(tabs)') })).toBe('/welcome');
      expect(routeFor({ ...base, segments: at('(app)', '(tabs)', tab) })).toBe('/welcome');
    });

    it.each(['welcome', 'sign-in', 'sign-up', 'forgot-password', 'check-inbox'])('leaves %s alone', (screen) => {
      expect(routeFor({ ...base, segments: at('(auth)', screen) })).toBeNull();
    });

    it('lets an email link reach the callback', () => {
      expect(routeFor({ ...base, segments: at('(auth)', 'auth', 'callback') })).toBeNull();
    });

    it('does not show set-password without a session', () => {
      expect(routeFor({ ...base, segments: at('(auth)', 'set-password') })).toBe('/welcome');
    });
  });

  describe('signed in', () => {
    const signedIn = { ...base, signedIn: true };

    it('stays in the app', () => {
      expect(routeFor({ ...signedIn, segments: at('(app)') })).toBeNull();
      expect(routeFor({ ...signedIn, segments: at('(app)', 'add-flight') })).toBeNull();
    });

    it.each(['groups', 'profile', 'settings'])('stays on the %s tab', (tab) => {
      // The dashboard is `(app)/(tabs)/index`: its segments stop at the group.
      expect(routeFor({ ...signedIn, segments: at('(app)', '(tabs)') })).toBeNull();
      expect(routeFor({ ...signedIn, segments: at('(app)', '(tabs)', tab) })).toBeNull();
    });

    it.each(['welcome', 'sign-in', 'check-inbox', 'set-password'])('leaves %s for the dashboard', (screen) => {
      expect(routeFor({ ...signedIn, segments: at('(auth)', screen) })).toBe('/');
    });

    it('moves on from the callback once the link produced a session (confirmation)', () => {
      expect(routeFor({ ...signedIn, segments: at('(auth)', 'auth', 'callback') })).toBe('/');
    });
  });

  describe('holding a password-reset session', () => {
    const recovering = { ...base, signedIn: true, isRecovering: true };

    it('goes from the callback to set-password, not the dashboard', () => {
      expect(routeFor({ ...recovering, segments: at('(auth)', 'auth', 'callback') })).toBe('/set-password');
    });

    it('cannot reach the app', () => {
      expect(routeFor({ ...recovering, segments: at('(app)') })).toBe('/set-password');
      expect(routeFor({ ...recovering, segments: at('(app)', '(tabs)', 'profile') })).toBe('/set-password');
      expect(routeFor({ ...recovering, segments: at('(app)', 'add-flight') })).toBe('/set-password');
    });

    it('stays on set-password', () => {
      expect(routeFor({ ...recovering, segments: at('(auth)', 'set-password') })).toBeNull();
    });

    it('ignores a stale recovery flag once signed out', () => {
      expect(routeFor({ ...base, isRecovering: true, segments: at('(auth)', 'welcome') })).toBeNull();
    });
  });
});

describe('a notification tap (use-notification-taps.ts navigates only to the dashboard)', () => {
  const dashboard = at('(app)', '(tabs)');

  it('keeps a signed-in user on the dashboard', () => {
    expect(routeFor({ ...base, signedIn: true, segments: dashboard })).toBeNull();
  });

  it('sends a signed-out user to welcome, cold start included', () => {
    // Cold start: nothing is decided until the keychain answers…
    expect(routeFor({ ...base, isLoading: true, segments: dashboard })).toBeNull();
    // …then signed out means welcome, whatever the tap wanted.
    expect(routeFor({ ...base, segments: dashboard })).toBe('/welcome');
  });

  it('cannot take a recovery session past set-password', () => {
    expect(routeFor({ ...base, signedIn: true, isRecovering: true, segments: dashboard })).toBe(
      '/set-password',
    );
  });
});

describe('linkExchangeFor (the email-link callback)', () => {
  it('waits while the stored session is unknown, so a cold start cannot overwrite it', () => {
    expect(linkExchangeFor({ isLoading: true, signedIn: false })).toBe('wait');
    expect(linkExchangeFor({ isLoading: true, signedIn: true })).toBe('wait');
  });

  it('exchanges only when signed out', () => {
    expect(linkExchangeFor({ isLoading: false, signedIn: false })).toBe('exchange');
  });

  it('never exchanges over a live session, which would swap accounts', () => {
    expect(linkExchangeFor({ isLoading: false, signedIn: true })).toBe('skip');
  });
});

