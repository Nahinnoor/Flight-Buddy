import { Stack } from 'expo-router';

/**
 * The signed-in half: the tabs, with the add-flight sheet above them.
 *
 * add-flight lives here, in the stack, not inside `(tabs)`. That is what lets
 * the tab bar's + open it over whichever tab is showing, and what brings the
 * user back to that same tab when it closes: the tabs navigator underneath is
 * never touched.
 *
 * Account and Flight log are pushed from Profile (Flight log also from the
 * dashboard), so they sit here too and cover the tab bar. The back button is
 * a bare chevron: the tab they came from has no title of its own to show.
 */
export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="add-flight"
        options={{ title: 'Add a flight', presentation: 'modal' }}
      />
      <Stack.Screen
        name="account"
        options={{ title: 'Account', headerBackButtonDisplayMode: 'minimal' }}
      />
      <Stack.Screen
        name="flight-log"
        options={{ title: 'Flight log', headerBackButtonDisplayMode: 'minimal' }}
      />
    </Stack>
  );
}
