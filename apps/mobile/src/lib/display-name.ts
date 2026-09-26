/**
 * The rule for a display name the user types on the Profile tab.
 *
 * Other people read this name: it is what group members see next to your
 * flight (`travelers.display_name`, §3.6). So it is trimmed, bounded, and may
 * not carry control characters — a newline or an escape sequence has no
 * business in a name and would only ever be used to make it look like
 * something else in a list or a log.
 *
 * Pure, no imports: tested by `display-name.test.ts`.
 */

export const DISPLAY_NAME_MAX_LENGTH = 50;

export type DisplayNameCheck =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// C0 controls, DEL and C1 controls, plus the invisible formatting characters
// that can make a name *look* like something it is not to the people who read
// it (§3.6): the bidi embeddings and overrides (U+202A–U+202E) and isolates
// (U+2066–U+2069) — an RTL override can reverse or disguise the text a group
// member sees — the LTR/RTL marks (U+200E–U+200F), the zero-width space
// (U+200B) and the byte-order mark (U+FEFF).
//
// Deliberately **allowed**: the zero-width joiner (U+200D), which builds emoji
// such as the pilot emoji, and the zero-width non-joiner (U+200C), which
// Persian and several Indic scripts need to spell names correctly. Neither can
// reorder text. Built from escapes so the file itself carries none of these.
const CONTROL_CHARACTERS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
);

export function checkDisplayName(input: string): DisplayNameCheck {
  const value = input.trim().replace(/\s+/g, ' ');
  if (value === '') return { ok: false, reason: 'Enter a name.' };
  if (CONTROL_CHARACTERS.test(input)) {
    return { ok: false, reason: 'Use letters, numbers and punctuation only.' };
  }
  // Counted in code points, so an emoji is one character, not two.
  if ([...value].length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, reason: `Keep it to ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, value };
}
