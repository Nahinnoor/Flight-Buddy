/**
 * Every user-facing string the auth screens show, in one place.
 *
 * ## Why the failure copy is deliberately vague
 *
 * An auth screen that says "no account with that email" is an account
 * enumeration oracle: anyone can feed it an address list and learn, for free
 * and at scale, which of those people have a FlightBuddy account. For an app
 * whose whole subject is who is flying where and with whom, that is a real
 * privacy leak, not a theoretical one.
 *
 * So the rules below are load-bearing, not lazy writing. Do not "improve" them
 * into something more specific. `src/lib/email-auth.ts` is where Supabase's
 * errors are mapped onto them, and `email-auth.test.ts` pins that mapping.
 *
 * 1. **Sign-in failure is one message** for a wrong password and an unknown
 *    address. The one exception is an unconfirmed account, which goes to the
 *    check-inbox screen instead — and that is safe only because Supabase
 *    checks the password *before* it checks confirmation (`token.go`,
 *    `ResourceOwnerPasswordGrant`), so "not confirmed" is only ever said to
 *    someone who already typed the right password.
 * 2. **A reset request always looks like it worked.** Same wording, same
 *    screen, whether or not the address is registered — and whether or not
 *    Supabase rate-limited it, because its email limit is per address and a
 *    rate-limit message would say "that address had mail recently".
 * 3. **Sign-up always lands on "check your inbox".** An "email already
 *    registered" error leaks just as loudly as an unknown-account error. With
 *    confirmation on, Supabase answers a duplicate sign-up with an obfuscated
 *    user and **sends no mail at all** (its docs: "you'll receive an
 *    obfuscated user response with no verification email sent"). So the
 *    screen promises only that *if* the address needs confirming, the mail is
 *    on its way; someone who already has an account is told how to sign in.
 *
 * The cost is honest and worth naming: a user who mistypes their address on
 * sign-up gets a screen that looks like success and an inbox that stays empty.
 * The "Wrong address?" escape hatch on the check-inbox screen exists for them.
 */

export const AuthCopy = {
  productName: 'FlightBuddy',
  tagline: 'Every leg of every trip, in one view.',

  /** Rule 1. Covers wrong password and unknown address. */
  signInFailed: 'Sign in failed. Check your email and password.',

  /** Rule 3. Never mentions whether the address was already taken. */
  signUpFailed: 'We could not finish that right now. Try again in a moment.',
  /**
   * Supabase refused the address itself (`email_address_invalid`: a reserved
   * or undeliverable domain). That is about the string typed, not about
   * whether anyone has an account, so it is safe to say.
   */
  addressRejected: 'We cannot send email to that address. Check it, or use a different one.',

  /** Rule 2. Identical for a registered and an unregistered address. */
  resetRequested: (email: string) =>
    `If ${email} has a FlightBuddy account, a reset link is on its way. It expires in an hour.`,
  resetFailed: 'We could not send that right now. Try again in a moment.',

  confirmRequired:
    'You need to confirm this address before you can sign in. The link expires in 24 hours.',
  resendFailed: 'We could not resend it right now. Try again in a moment.',
  resent: 'Sent. Give it a minute, then check your spam folder.',

  /**
   * Transport failures only: the request never reached Supabase, so the
   * answer cannot depend on the address. Anything that did reach it maps to
   * one of the neutral messages above instead.
   */
  offline: 'We could not reach FlightBuddy. Check your connection and try again.',
  /** Per-IP, not per-account, so it says nothing about any address. */
  tooManyAttempts: 'Too many attempts. Wait a minute, then try again.',

  /** Apple and Google. The provider's own error text is never shown. */
  socialFailed: (provider: 'Apple' | 'Google') =>
    `Sign in with ${provider} did not finish. Try again.`,

  // ---------------------------------------------------- set a new password --
  setPasswordTitle: 'Set a new password',
  setPasswordIntro: 'Choose a new password for your account. You will stay signed in afterwards.',
  setPasswordFailed: 'We could not save that password right now. Try again in a moment.',
  samePassword: 'That is your current password. Choose a different one.',
  weakPassword: 'Choose a longer or less common password.',
  recoveryExpired:
    'This reset session has expired. Request a new link from the sign-in screen.',

  // ------------------------------------------------------ incoming links --
  linkWorking: 'Signing you in…',
  linkExpired:
    'This link has expired or has already been used. If you were confirming your email, try signing in — it may already be confirmed.',
  /**
   * PKCE binds the link to the phone that asked for it. Opening it anywhere
   * else fails the exchange — but a confirmation link has already confirmed
   * the address by the time it reaches the app, so signing in works.
   */
  linkOtherDevice:
    'Open this link on the phone where you asked for it. If you were confirming your email, it is confirmed — you can sign in now.',
  linkUnrecognised: 'That link is not one FlightBuddy can use.',

  privacyNote: 'We only use your name and email to show who is on which flight.',
} as const;

export const FieldCopy = {
  nameLabel: 'Your name',
  // `profiles.display_name` is NOT NULL (§6.2). Apple and Google hand one over;
  // an email sign-up has to ask for it, and passes it as `full_name`, which is
  // what the `on_auth_user_created` trigger reads.
  nameHint: 'Shown to the people you travel with.',
  emailLabel: 'Email',
  passwordLabel: 'Password',
  newPasswordLabel: 'Choose a password',
  passwordHint: 'At least 8 characters.',
} as const;
