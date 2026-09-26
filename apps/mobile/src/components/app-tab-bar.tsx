/**
 * The signed-in app's tab bar: Dashboard · Groups · + · Profile · Settings.
 *
 * Rendered through the JS tabs navigator's `tabBar` prop, so the navigator
 * still owns state, headers and lazy screens while this file owns every pixel
 * of the bar. That is what makes the centre **+** possible: it is not a tab
 * and not a route in this navigator at all, just a button that pushes the
 * add-flight modal onto the stack *above* the tabs. So it can never become the
 * selected tab, and closing the sheet lands the user on whichever tab they
 * were already on.
 *
 * Accessibility: the bar is a `tablist`; each tab is a `tab` with its label and
 * `selected` state; + is a `button`. Every target is at least 44×44 pt (tabs
 * are 49 pt tall and a fifth of the width; + is 56 pt). The bottom inset keeps
 * everything clear of the home indicator.
 */
import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type SymbolName = Extract<SymbolViewProps['name'], string>;

interface TabSpec {
  label: string;
  icon: SymbolName;
  selectedIcon: SymbolName;
}

/** Keyed by route name inside `(tabs)`. Order here is display order. */
const TABS: Record<string, TabSpec> = {
  index: { label: 'Dashboard', icon: 'house', selectedIcon: 'house.fill' },
  groups: { label: 'Groups', icon: 'person.2', selectedIcon: 'person.2.fill' },
  profile: { label: 'Profile', icon: 'person.crop.circle', selectedIcon: 'person.crop.circle.fill' },
  settings: { label: 'Settings', icon: 'gearshape', selectedIcon: 'gearshape.fill' },
};

/** The + sits after this many tabs. */
const TABS_BEFORE_ADD = 2;

const BAR_HEIGHT = 49;
const ADD_SIZE = 56;
/** How far the + rises above the bar's top edge. */
export const ADD_BUTTON_OVERHANG = 18;
/** Bottom padding a scrolling screen needs so its last row clears the raised +. */
export const TAB_SCREEN_BOTTOM_INSET = ADD_BUTTON_OVERHANG + Spacing.four;

/** Presses on + closer together than this open one sheet, not two. */
export const ADD_PRESS_GUARD_MS = 800;

export function AppTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const theme = useTheme();
  const router = useRouter();

  // A fast double-tap fires two presses before the sheet covers the bar, and
  // `push` would stack two add-flight sheets (the second dismiss then reveals
  // the first, not your tab). While the sheet is up the bar is covered, so a
  // short window after each press is all the guard needs.
  const lastAddPress = useRef(0);
  const openAddFlight = useCallback(() => {
    const now = Date.now();
    if (now - lastAddPress.current < ADD_PRESS_GUARD_MS) return;
    lastAddPress.current = now;
    router.push('/add-flight');
  }, [router]);

  const tabs = state.routes
    .filter((route) => TABS[route.name] !== undefined)
    .map((route) => {
      const spec = TABS[route.name] as TabSpec;
      const isFocused = state.routes[state.index]?.key === route.key;
      const onPress = () => {
        const event = navigation.emit({
          type: 'tabPress',
          target: route.key,
          canPreventDefault: true,
        });
        if (!isFocused && !event.defaultPrevented) {
          navigation.navigate(route.name, route.params);
        }
      };
      const onLongPress = () => navigation.emit({ type: 'tabLongPress', target: route.key });
      const label = descriptors[route.key]?.options.tabBarAccessibilityLabel ?? spec.label;

      return (
        <Pressable
          key={route.key}
          accessibilityRole="tab"
          accessibilityLabel={label}
          accessibilityState={{ selected: isFocused }}
          onPress={onPress}
          onLongPress={onLongPress}
          style={({ pressed }) => [styles.tab, { opacity: pressed ? 0.6 : 1 }]}>
          <SymbolView
            name={isFocused ? spec.selectedIcon : spec.icon}
            tintColor={isFocused ? theme.accent : theme.textSecondary}
            size={24}
            fallback={null}
          />
          <ThemedText
            style={[styles.label, { color: isFocused ? theme.accent : theme.textSecondary }]}
            numberOfLines={1}
            // UIKit's tab bar does not grow its labels with Dynamic Type
            // either; five labels must fit a 375pt-wide phone. VoiceOver reads
            // the full label from `accessibilityLabel` regardless.
            maxFontSizeMultiplier={1.15}>
            {spec.label}
          </ThemedText>
        </Pressable>
      );
    });

  const addButton = (
    <View key="add" style={styles.addSlot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a flight"
        accessibilityHint="Opens the add-flight sheet over this screen"
        onPress={openAddFlight}
        style={({ pressed }) => [
          styles.add,
          {
            backgroundColor: theme.accent,
            borderColor: theme.background,
            shadowColor: theme.shadow,
            opacity: pressed ? 0.85 : 1,
            transform: [{ scale: pressed ? 0.96 : 1 }],
          },
        ]}>
        <SymbolView name="plus" tintColor={theme.onAccent} size={26} weight="bold" fallback={null} />
      </Pressable>
    </View>
  );

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: theme.background,
          borderTopColor: theme.border,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}>
      <View style={styles.row}>
        {tabs.slice(0, TABS_BEFORE_ADD)}
        {addButton}
        {tabs.slice(TABS_BEFORE_ADD)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    // The + is drawn outside the bar's box; it must not be clipped.
    overflow: 'visible',
  },
  row: {
    flexDirection: 'row',
    height: BAR_HEIGHT,
    alignItems: 'stretch',
  },
  tab: {
    flex: 1,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: Spacing.one,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
  addSlot: {
    flex: 1,
    alignItems: 'center',
  },
  add: {
    width: ADD_SIZE,
    height: ADD_SIZE,
    borderRadius: ADD_SIZE / 2,
    // Centred on the bar's top edge plus the overhang.
    marginTop: -ADD_BUTTON_OVERHANG,
    alignItems: 'center',
    justifyContent: 'center',
    // A ring in the page colour separates the button from whatever scrolls
    // behind its raised half.
    borderWidth: 3,
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
});
