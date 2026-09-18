import { Stack } from 'expo-router';

import { AuthDraftProvider } from '@/components/auth/auth-draft';

/**
 * Every signed-out screen, plus the two that sit at the boundary: the email
 * link callback and set-a-new-password. The root guard (`src/app/_layout.tsx`)
 * decides who may be here.
 */
export default function AuthLayout() {
  return (
    <AuthDraftProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="forgot-password" />
        <Stack.Screen name="check-inbox" />
        {/* No swipe-back: there is nothing behind these to go back to. */}
        <Stack.Screen name="set-password" options={{ gestureEnabled: false }} />
        <Stack.Screen name="auth/callback" options={{ gestureEnabled: false, animation: 'fade' }} />
      </Stack>
    </AuthDraftProvider>
  );
}
