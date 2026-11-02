/**
 * Reload a screen's data each time it gains focus, so a change made on another
 * screen shows up on the way back without a manual pull.
 */
import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

/** Calls `reload` on every focus. Its promise is not awaited. */
export function useReloadOnFocus(reload: () => Promise<unknown>): void {
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
}
