/**
 * The user's appearance choice — System, Light or Dark — applied app-wide.
 *
 * It works through React Native's own `Appearance.setColorScheme`, not a
 * parallel "effective scheme" context. On iOS that sets the window's
 * `overrideUserInterfaceStyle`, so *everything* follows it without any other
 * file knowing: `useColorScheme()` (and so `useTheme`, `useIllustration` and
 * the navigation theme in the root layout), native headers and modal sheets,
 * the keyboard, the date picker, alerts and the status bar. `unspecified`
 * removes the override and the app follows the system again.
 *
 * Stored on the device only (AsyncStorage — it is a display preference, not a
 * secret and not account data), and defaulting to System. A failed read or
 * write degrades to System / "not remembered"; it never blocks the app.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  APPEARANCE_STORAGE_KEY,
  colorSchemeOverride,
  parseAppearancePreference,
  type AppearancePreference,
} from '@/lib/appearance';

interface AppearanceContextValue {
  preference: AppearancePreference;
  setPreference: (next: AppearancePreference) => void;
  /** The stored preference has been read and applied (or the read failed). */
  isReady: boolean;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<AppearancePreference>('system');
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(APPEARANCE_STORAGE_KEY)
      .then((stored) => {
        if (!active) return;
        const restored = parseAppearancePreference(stored);
        setPreferenceState(restored);
        Appearance.setColorScheme(colorSchemeOverride(restored));
      })
      .catch((error: unknown) => {
        console.warn(
          '[appearance] could not read the stored preference',
          error instanceof Error ? error.name : 'unknown',
        );
      })
      .finally(() => {
        if (active) setIsReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback((next: AppearancePreference) => {
    setPreferenceState(next);
    Appearance.setColorScheme(colorSchemeOverride(next));
    AsyncStorage.setItem(APPEARANCE_STORAGE_KEY, next).catch((error: unknown) => {
      console.warn(
        '[appearance] could not store the preference',
        error instanceof Error ? error.name : 'unknown',
      );
    });
  }, []);

  const value = useMemo(
    () => ({ preference, setPreference, isReady }),
    [preference, setPreference, isReady],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (value === null) throw new Error('useAppearance must be used inside <AppearanceProvider>');
  return value;
}
