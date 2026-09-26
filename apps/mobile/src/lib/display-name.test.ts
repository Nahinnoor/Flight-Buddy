import { describe, expect, it } from 'vitest';

import { checkDisplayName, DISPLAY_NAME_MAX_LENGTH } from './display-name';

describe('checkDisplayName', () => {
  it('trims and collapses inner whitespace', () => {
    expect(checkDisplayName('  Sam   Rivera ')).toEqual({ ok: true, value: 'Sam Rivera' });
  });

  it('refuses an empty or blank name', () => {
    expect(checkDisplayName('').ok).toBe(false);
    expect(checkDisplayName('    ').ok).toBe(false);
  });

  it('refuses control characters, including a newline inside the name', () => {
    expect(checkDisplayName('Sam\nRivera').ok).toBe(false);
    expect(checkDisplayName('Sam\u0007').ok).toBe(false);
    expect(checkDisplayName('Sam\u009b31m').ok).toBe(false);
  });

  it('refuses the invisible characters that can disguise a name to other people', () => {
    // Right-to-left override: renders "Sam" + reversed text, a classic spoof.
    expect(checkDisplayName('Sam\u202Eredlo').ok).toBe(false);
    for (const hidden of ['\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(checkDisplayName(`Sam${hidden}Rivera`).ok).toBe(false);
    }
    expect(checkDisplayName('Sam\u200BRivera').ok).toBe(false); // zero-width space
    expect(checkDisplayName('Sam\u200ERivera').ok).toBe(false); // LTR mark
    expect(checkDisplayName('Sam\u200FRivera').ok).toBe(false); // RTL mark
    expect(checkDisplayName('\uFEFFSam').ok).toBe(false); // byte-order mark
  });

  it('keeps the joiners real names and emoji need', () => {
    // Woman pilot: woman + ZWJ + airplane (+ variation selector).
    expect(checkDisplayName('Sam \u{1F469}\u200D\u2708\uFE0F').ok).toBe(true);
    // Zero-width non-joiner, required to spell Persian words correctly.
    expect(checkDisplayName('\u0645\u06CC\u200C\u0631\u0648\u0645').ok).toBe(true);
  });

  it('allows accents, apostrophes, hyphens and emoji', () => {
    expect(checkDisplayName("Zoë O'Neill-Å").ok).toBe(true);
    expect(checkDisplayName('Sam ✈️').ok).toBe(true);
  });

  it('bounds the length in characters, not UTF-16 units', () => {
    expect(checkDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(checkDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)).ok).toBe(false);
    expect(checkDisplayName('😀'.repeat(DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
  });
});
