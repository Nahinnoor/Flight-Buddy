import { Stack } from 'expo-router';

/**
 * The signed-in half: the tabs, with the add-flight sheet above them.
 *
 * add-flight lives here, in the stack, not inside `(tabs)`. That is what lets
 * the tab bar's + open it over whichever tab is showing, and what brings the
 * user back to that same tab when it closes: the tabs navigator underneath is
 * never touched.
 */
export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="add-flight"
        options={{ title: 'Add a flight', presentation: 'modal' }}
      />
    </Stack>
  );
}
