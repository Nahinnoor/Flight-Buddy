import { Stack } from 'expo-router';

/**
 * No tab bar. Phase 1 is one screen plus a modal; a single-tab tab bar is
 * chrome that costs vertical space and says nothing. Groups (§3.2) get their
 * own tab when they land.
 */
export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Your flights' }} />
      <Stack.Screen
        name="add-flight"
        options={{ title: 'Add a flight', presentation: 'modal' }}
      />
    </Stack>
  );
}
