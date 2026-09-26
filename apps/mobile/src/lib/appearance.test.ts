import { describe, expect, it } from 'vitest';

import { colorSchemeOverride, parseAppearancePreference } from './appearance';

describe('parseAppearancePreference', () => {
  it('defaults to system when nothing is stored', () => {
    expect(parseAppearancePreference(null)).toBe('system');
    expect(parseAppearancePreference(undefined)).toBe('system');
  });

  it('reads the two overrides back', () => {
    expect(parseAppearancePreference('light')).toBe('light');
    expect(parseAppearancePreference('dark')).toBe('dark');
  });

  it('treats anything else, including a corrupt value, as system', () => {
    expect(parseAppearancePreference('DARK')).toBe('system');
    expect(parseAppearancePreference('{"scheme":"dark"}')).toBe('system');
  });
});

describe('colorSchemeOverride', () => {
  it('removes the override for system and forces the scheme otherwise', () => {
    expect(colorSchemeOverride('system')).toBe('unspecified');
    expect(colorSchemeOverride('light')).toBe('light');
    expect(colorSchemeOverride('dark')).toBe('dark');
  });
});
