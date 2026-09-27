/**
 * The four tabs. JS tabs (`expo-router/js-tabs`) with a custom `tabBar`, not
 * native tabs: the design has a raised, accent-coloured + in the middle that
 * is a button rather than a tab, and native tabs (still
 * `expo-router/unstable-native-tabs` in SDK 57) render only system tab items —
 * the + would have to be a fifth tab whose press is intercepted, drawn like
 * every other tab. See `src/components/app-tab-bar.tsx`.
 */
import { Tabs } from 'expo-router/js-tabs';

import { AppTabBar } from '@/components/app-tab-bar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      // expo-router's own tab router defaults to `firstRoute` (stock React
      // Navigation defaults to `history`), so any GO_BACK that reaches this
      // navigator jumped to Dashboard. The owner's rule is that adding a flight
      // leaves you on the tab you were on; `history` keeps that true for every
      // path, not just the one add-flight now uses.
      backBehavior="history"
      // An inline navigation title is a fixed size in UIKit too; scaled up it
      // truncates to "Your fli…" at the largest text sizes.
      screenOptions={{ headerTitleAllowFontScaling: false }}>
      <Tabs.Screen name="index" options={{ title: 'Your flights' }} />
      <Tabs.Screen name="groups" options={{ title: 'Groups' }} />
      {/* Profile draws its own large title, with the Edit button beside it. */}
      <Tabs.Screen name="profile" options={{ title: 'Profile', headerShown: false }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
