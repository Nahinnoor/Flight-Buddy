/**
 * Keeps this device registered for flight alerts while signed in (ADR 0006,
 * sub-step iii). Mounted once, in `SessionProvider`.
 *
 * - **Sign-in / launch:** registers once per signed-in user per app run, with
 *   the permission prompt if permission is undecided (unchanged behaviour).
 * - **Foreground:** registers again without prompting, throttled
 *   (`push-refresh.ts`), so a device whose row was moved, retired or
 *   invalidated is back within one return to the app, not one cold launch.
 * - **Token change:** registers the new token Expo reports, bypassing the
 *   throttle.
 *
 * The refresh paths never run while signed out, during a password reset, or
 * while a sign-out is clearing the token (`signingOut`). Failures are logged
 * as fixed codes only and never shown; the token is never logged.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

import { isRegisteredDeviceToken, registerPushToken } from '@/lib/push';
import { PushRefreshGate, type RefreshOutcome, type RefreshRequest } from '@/lib/push-refresh';

interface Options {
  userId: string | null;
  isRecovering: boolean;
  /** True from the start of a sign-out until a new session exists. */
  signingOut: RefObject<boolean>;
}

/** The gate's `register`: runs `registerPushToken` and reduces the result to an outcome. */
async function registerFor(
  request: RefreshRequest<Notifications.DevicePushToken>,
): Promise<RefreshOutcome> {
  const result = await registerPushToken({
    prompt: request.prompt,
    devicePushToken: request.token,
  });
  // A skip (simulator, denied) is only worth a line on the sign-in path; a
  // refresh would repeat it on every return to the app.
  if (result.status === 'failed' || (result.status === 'skipped' && request.trigger === 'sign-in')) {
    console.log(`[push] token not stored (${request.trigger}): ${result.status} (${result.reason})`);
  }
  return result.status;
}

/** See the file comment. Called once, by `SessionProvider`. */
export function usePushTokenRefresh({ userId, isRecovering, signingOut }: Options): void {
  const live = useRef({ userId, isRecovering });
  useEffect(() => {
    live.current = { userId, isRecovering };
  }, [userId, isRecovering]);

  // Created in an effect rather than during render: its predicate reads refs.
  // Declared before the sign-in effect, so it exists when that first runs.
  const gate = useRef<PushRefreshGate<Notifications.DevicePushToken> | null>(null);
  useEffect(() => {
    const current = new PushRefreshGate<Notifications.DevicePushToken>({
      now: Date.now,
      canRegister: () =>
        live.current.userId !== null && !live.current.isRecovering && !signingOut.current,
      isRegistered: isRegisteredDeviceToken,
      register: registerFor,
    });
    gate.current = current;

    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void current.foreground();
    });
    const tokens = Notifications.addPushTokenListener((token) => {
      void current.tokenChanged(token);
    });
    return () => {
      appState.remove();
      tokens.remove();
      current.reset();
      if (gate.current === current) gate.current = null;
    };
  }, [signingOut]);

  // Keyed on the user id rather than the session object, so a token refresh
  // does not re-register. Registering also moves this device's token off any
  // other account that still holds it (`register_push_token`).
  const registeredFor = useRef<string | null>(null);
  useEffect(() => {
    if (userId === null) {
      registeredFor.current = null;
      gate.current?.reset();
      return;
    }
    if (registeredFor.current === userId) return;
    registeredFor.current = userId;
    void gate.current?.signedIn();
  }, [userId]);
}
