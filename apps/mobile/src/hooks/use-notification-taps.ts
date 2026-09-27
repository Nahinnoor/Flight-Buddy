/**
 * Notification taps and foreground arrivals, wired to the router and the
 * Dashboard. Mounted once, in the root navigator, under the session provider.
 *
 * **Taps, warm and cold.** `useLastNotificationResponse` (SDK 57) covers both:
 * on mount it reads `getLastNotificationResponse()` — the tap that launched a
 * killed app, which native code recorded before JS started — and then listens
 * for taps while the app is running. Each response is handled once: its
 * notification id and date are remembered, and the stored response is cleared
 * with `clearLastNotificationResponse()` so a remount or reload cannot replay it.
 *
 * **What a tap does** is decided in `notification-tap.ts`: `data` is validated
 * there, and the only destination is the fixed Dashboard href. A cold-start tap
 * waits for the stored session; signed out (or mid password reset) it is
 * dropped, and the route guard's own redirect stands. The flight id goes to the
 * Dashboard through `flight-alert-store.ts`, never into a route.
 *
 * **Foreground arrivals** (the handler in `push.ts` shows them as banners)
 * refresh the Dashboard so the card reflects the change.
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';

import {
  requestDashboardRefresh,
  requestFlightHighlight,
  resetFlightAlerts,
} from '@/lib/flight-alert-store';
import {
  DASHBOARD_HREF,
  parseNotificationData,
  refreshesDashboard,
  tapActionFor,
} from '@/lib/notification-tap';

interface SessionGate {
  isLoading: boolean;
  signedIn: boolean;
  isRecovering: boolean;
}

function responseKey(response: Notifications.NotificationResponse): string {
  const { notification } = response;
  return `${notification.request.identifier}:${notification.date}`;
}

export function useNotificationTaps({ isLoading, signedIn, isRecovering }: SessionGate): void {
  const router = useRouter();
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    // `undefined` until the hook has read the stored response; `null` for none.
    if (lastResponse === undefined || lastResponse === null) return;
    const key = responseKey(lastResponse);
    if (handled.current === key) return;

    const decision = tapActionFor({
      isLoading,
      signedIn,
      isRecovering,
      isDefaultAction: lastResponse.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER,
      payload: parseNotificationData(lastResponse.notification.request.content.data),
    });
    if (decision.action === 'wait') return;

    handled.current = key;
    Notifications.clearLastNotificationResponse();

    if (decision.action === 'open-dashboard') {
      requestFlightHighlight(decision.flightId);
      router.navigate(DASHBOARD_HREF);
    }
  }, [lastResponse, isLoading, signedIn, isRecovering, router]);

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      if (refreshesDashboard(parseNotificationData(notification.request.content.data))) {
        requestDashboardRefresh();
      }
    });
    return () => subscription.remove();
  }, []);

  // Nothing a previous account asked for survives its sign-out.
  useEffect(() => {
    if (!signedIn) resetFlightAlerts();
  }, [signedIn]);
}
