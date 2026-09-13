/**
 * Expo push token registration.
 *
 * Phase 1 does not send anything; the poller in Phase 2 reads
 * `profiles.expo_push_token`. Registering now means the column is populated for
 * everyone who signed in before notifications shipped, rather than only for
 * people who happened to reopen the app afterwards.
 *
 * Nothing in here is allowed to be fatal. A user who declines notifications, or
 * is on a simulator, must still land on the dashboard.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import { supabase } from './supabase';

export type PushRegistrationResult =
  | { status: 'registered' }
  | { status: 'skipped'; reason: 'simulator' | 'denied' | 'no-project-id' | 'unsupported' }
  | { status: 'failed'; reason: string };

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
 * Asks for notification permission and stores the resulting token against the
 * signed-in profile.
 *
 * Called after sign-in rather than at launch, deliberately: iOS gives an app
 * exactly one permission prompt, and spending it on a cold start before the
 * user knows what the app does is how you get a permanent denial.
 */
export async function registerPushToken(userId: string): Promise<PushRegistrationResult> {
  // Push certificates are not wired to the simulator; asking produces an error
  // rather than a prompt, so this is a clean skip, not a failure.
  if (!Device.isDevice) return { status: 'skipped', reason: 'simulator' };
  if (Platform.OS === 'web') return { status: 'skipped', reason: 'unsupported' };

  try {
    if (Platform.OS === 'android') {
      // Android 13+ will not show the permission prompt without a channel.
      await Notifications.setNotificationChannelAsync('flight-updates', {
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

    const { error } = await supabase
      .from('profiles')
      .update({ expo_push_token: token })
      .eq('id', userId);
    if (error !== null) return { status: 'failed', reason: error.message };

    return { status: 'registered' };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/**
 * How a delivered notification behaves while the app is foregrounded. A gate
 * change is worth interrupting for, so it is shown rather than silently
 * collected.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}
