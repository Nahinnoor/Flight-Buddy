/**
 * Expo push token registration, and how notifications behave in the app.
 *
 * The worker reads `profiles.expo_push_token` and sends each flight alert to
 * it (Phase 2, wave 5). A device's token must belong to **at most one
 * account**: otherwise, after A signs out and B signs in on the same phone,
 * A's alerts — flight number, route, gate — land on B's lock screen. Two
 * database functions (migration `20260926130000_push_token_single_owner`)
 * keep that true:
 *
 * - `register_push_token` sets this device's token on the signed-in profile
 *   and removes it from every other profile, atomically. It is the only way
 *   the app writes the column.
 * - `unregister_push_token` runs on sign-out, while the session still exists
 *   (RLS needs it), and clears the profile's token only if it is still this
 *   device's — a newer registration from another phone survives.
 *
 * Both take the token in the RPC's POST body. It never goes in a URL, a log
 * line, an error, or the UI; failures are reported as fixed codes
 * (`push-token.ts`).
 *
 * Nothing in here is allowed to be fatal. A user who declines notifications, or
 * is on a simulator, must still land on the dashboard; a sign-out must still
 * sign out.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import { isExpoPushToken, safeRpcFailure, safeThrownFailure } from './push-token';
import { supabase } from './supabase';

export type PushRegistrationResult =
  | { status: 'registered' }
  | { status: 'skipped'; reason: 'simulator' | 'denied' | 'no-project-id' | 'unsupported' }
  /** `reason` is a fixed code (`rpc:22023`, `thrown:TypeError`), never a message. */
  | { status: 'failed'; reason: string };

export type PushUnregisterResult =
  | { status: 'cleared' }
  | { status: 'skipped'; reason: 'no-token' }
  | { status: 'failed'; reason: string };

/** Must match the worker's `ANDROID_CHANNEL_ID` (services/poller/src/push/pushSend.ts). */
const ANDROID_CHANNEL_ID = 'flight-updates';

/** Sign-out waits at most this long for the token to be cleared. */
const UNREGISTER_TIMEOUT_MS = 5_000;

/**
 * The token this device registered in this app run. Kept in memory only, so
 * sign-out can clear it without asking Expo again. Not persisted: storing a
 * credential somewhere new is a cost with no benefit here.
 */
let registeredToken: string | null = null;

/**
 * A registration still on its way to the database. Sign-out waits for it, or
 * a registration that lands after the clear would put the token straight back
 * on the account that just signed out.
 */
let inflightRegistration: Promise<PushRegistrationResult> | null = null;

/**
 * `getExpoPushTokenAsync` defaults to `extra.eas.projectId`, but the default is
 * only consulted in some build contexts, so it is read and passed explicitly.
 */
function projectId(): string | undefined {
  const fromConfig = Constants.expoConfig?.extra?.eas?.projectId as unknown;
  if (typeof fromConfig === 'string' && fromConfig !== '') return fromConfig;

  const fromEas = (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  return typeof fromEas === 'string' && fromEas !== '' ? fromEas : undefined;
}

/**
 * Asks for notification permission and registers this device's token to the
 * signed-in profile (and to no other).
 *
 * Called after sign-in rather than at launch, deliberately: iOS gives an app
 * exactly one permission prompt, and spending it on a cold start before the
 * user knows what the app does is how you get a permanent denial.
 *
 * Runs on every sign-in and every launch while signed in, which is what moves
 * the token off a previous account on this phone even when that account never
 * signed out (the app was deleted, or the session expired).
 */
export function registerPushToken(): Promise<PushRegistrationResult> {
  const attempt = register();
  inflightRegistration = attempt;
  void attempt.finally(() => {
    if (inflightRegistration === attempt) inflightRegistration = null;
  });
  return attempt;
}

async function register(): Promise<PushRegistrationResult> {
  // Push certificates are not wired to the simulator; asking produces an error
  // rather than a prompt, so this is a clean skip, not a failure.
  if (!Device.isDevice) return { status: 'skipped', reason: 'simulator' };
  if (Platform.OS === 'web') return { status: 'skipped', reason: 'unsupported' };

  try {
    if (Platform.OS === 'android') {
      // Android 13+ will not show the permission prompt without a channel.
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: 'Flight updates',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return { status: 'skipped', reason: 'denied' };

    const id = projectId();
    if (id === undefined) return { status: 'skipped', reason: 'no-project-id' };

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    if (!isExpoPushToken(token)) return { status: 'failed', reason: 'unexpected-token-shape' };

    const { error } = await supabase.rpc('register_push_token', { p_token: token });
    if (error !== null) return { status: 'failed', reason: safeRpcFailure(error) };

    registeredToken = token;
    return { status: 'registered' };
  } catch (error) {
    return { status: 'failed', reason: safeThrownFailure(error) };
  }
}

/**
 * This device's token, without prompting: the one registered this run, or —
 * if registration did not run or failed this time — asked of Expo again, but
 * only when permission is already granted.
 */
async function thisDevicesToken(): Promise<string | null> {
  if (registeredToken !== null) return registeredToken;
  if (!Device.isDevice || Platform.OS === 'web') return null;

  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return null;
  const id = projectId();
  if (id === undefined) return null;

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  return isExpoPushToken(token) ? token : null;
}

async function unregister(): Promise<PushUnregisterResult> {
  try {
    if (inflightRegistration !== null) await inflightRegistration;
    const token = await thisDevicesToken();
    if (token === null) return { status: 'skipped', reason: 'no-token' };

    const { error } = await supabase.rpc('unregister_push_token', { p_token: token });
    if (error !== null) return { status: 'failed', reason: safeRpcFailure(error) };

    registeredToken = null;
    return { status: 'cleared' };
  } catch (error) {
    return { status: 'failed', reason: safeThrownFailure(error) };
  }
}

/**
 * Removes this device's token from the signed-in profile. Call it **before**
 * the session ends: the database function runs under the user's own RLS.
 *
 * Best effort and bounded: never throws, and gives up after
 * `UNREGISTER_TIMEOUT_MS` so a bad network cannot hold sign-out hostage. If it
 * does not get through, the next account to register on this phone removes
 * the token from this profile anyway (`register_push_token`).
 */
export async function unregisterPushToken(): Promise<PushUnregisterResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PushUnregisterResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed', reason: 'timeout' }), UNREGISTER_TIMEOUT_MS);
  });
  try {
    return await Promise.race([unregister(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How a notification behaves when it arrives while the app is in the
 * foreground. A gate change is worth interrupting for, so it is shown as a
 * banner and kept in Notification Centre, with sound, exactly as it would be
 * with the app closed.
 *
 * SDK 57 fields: `shouldShowBanner` / `shouldShowList` (the older
 * `shouldShowAlert` is deprecated). The handler must answer within 3 seconds or
 * the notification is dropped, so it does no work of its own; refreshing the
 * dashboard is the received-listener's job (`use-notification-taps.ts`).
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
  });
}
