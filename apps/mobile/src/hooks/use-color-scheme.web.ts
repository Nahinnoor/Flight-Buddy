import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Web build of `useColorScheme`.
 *
 * Static rendering has no device theme, so the server pass has to commit to
 * one; `light` is the choice, and the real value is picked up once the client
 * takes over. `useSyncExternalStore` is what reports "we are on the client now"
 * — the template did it with `useState` + `useEffect`, which React 19's
 * `set-state-in-effect` rule (correctly) rejects as a cascading render.
 */
export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const colorScheme = useRNColorScheme();

  return hasHydrated ? colorScheme : 'light';
}
