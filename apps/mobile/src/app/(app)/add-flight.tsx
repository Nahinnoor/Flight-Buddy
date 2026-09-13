/**
 * Add a flight (§3.1).
 *
 * One field. The user types what is on their boarding pass — `DL1234 Mar 12`,
 * `DL 1234 tomorrow` — and that free text goes to the API, which owns the
 * parse. The date picker is a fallback for when the text form loses an
 * argument with an ambiguous date, and it sends the explicit
 * `{ flightNumber, dateLocal }` form instead.
 *
 * The rule this screen exists to enforce: **never auto-pick `[0]`** (§8.12). A
 * flight number can operate two legs on one date, and silently choosing the
 * first puts someone on the wrong aeroplane with a confident-looking card. Even
 * a single result is shown for confirmation before it is added.
 */
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { formatAirportLocal, parseFlightDesignator, type FlightCandidate } from '@flightbuddy/shared';

import { cardDataFromCandidate, FlightCard } from '@/components/flight-card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { addFlight, describeError, lookupFlights } from '@/lib/api';
import {
  deviceTimeZone,
  fromLocalDateString,
  todayLocal,
  toLocalDateString,
} from '@/lib/device-time';
import { MOCK_API } from '@/lib/env';
import { designator as formatDesignator, formatLocalDateShort } from '@/lib/flight-display';
import { MOCK_DESIGNATORS } from '@/lib/mock/candidates';

type Phase =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'results'; candidates: FlightCandidate[] }
  | { kind: 'confirm'; candidate: FlightCandidate }
  | { kind: 'adding'; candidate: FlightCandidate };

export default function AddFlightScreen() {
  const theme = useTheme();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  // A second tap while a lookup is in flight must cancel the first, not race it.
  const inFlight = useRef<AbortController | null>(null);

  const search = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setError(null);
    setPhase({ kind: 'searching' });

    try {
      // With a picked date the text only has to yield a flight number; without
      // one the whole string goes to the API, which owns the free-text parse.
      const request =
        pickedDate !== null
          ? (() => {
              const parsed = parseFlightDesignator(query);
              if (parsed === null) {
                throw new Error('Enter a flight number, for example DL1234.');
              }
              return { flightNumber: parsed.designator, dateLocal: pickedDate };
            })()
          : // `today` and `timeZone` travel with the query so that "tomorrow"
            // resolves against the device's calendar, never the server's
            // (§8.4). The server has no business knowing what day it is here.
            { query: query.trim(), today: todayLocal(), timeZone: deviceTimeZone() };

      const { candidates } = await lookupFlights(request, controller.signal);
      if (controller.signal.aborted) return;

      setPhase(
        candidates.length === 1 && candidates[0] !== undefined
          ? { kind: 'confirm', candidate: candidates[0] }
          : { kind: 'results', candidates },
      );
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(describeError(caught));
      setPhase({ kind: 'idle' });
    }
  }, [pickedDate, query]);

  const confirm = useCallback(
    async (candidate: FlightCandidate) => {
      setError(null);
      setPhase({ kind: 'adding', candidate });
      try {
        await addFlight({ candidate });
        router.back();
      } catch (caught) {
        setError(describeError(caught));
        setPhase({ kind: 'confirm', candidate });
      }
    },
    [router],
  );

  const onDateChange = useCallback((event: DateTimePickerEvent, date?: Date) => {
    // Android's dialog reports dismissal through the event; iOS's inline picker
    // stays mounted and simply reports the new value.
    if (Platform.OS !== 'ios') setIsPickerOpen(false);
    if (event.type === 'dismissed' || date === undefined) return;
    setPickedDate(toLocalDateString(date));
  }, []);

  const canSearch = query.trim().length >= 3 && phase.kind !== 'searching';

  return (
    <ThemedView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.inner}>
            <View style={styles.field}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                FLIGHT
              </ThemedText>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="DL1234 Mar 12"
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={() => {
                  if (canSearch) void search();
                }}
                accessibilityLabel="Flight number and date"
                style={[
                  styles.input,
                  {
                    color: theme.text,
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              />
              <ThemedText type="small" themeColor="textSecondary">
                {MOCK_API
                  ? `Mock mode — try ${MOCK_DESIGNATORS.join(', ')}`
                  : 'Flight number and date. “tomorrow” works too.'}
              </ThemedText>
            </View>

            <View style={styles.field}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (pickedDate === null) setPickedDate(toLocalDateString(new Date()));
                  setIsPickerOpen((open) => !open);
                }}>
                <ThemedText type="small" style={{ color: theme.accent }}>
                  {pickedDate === null
                    ? 'Pick a date instead'
                    : `Date: ${formatLocalDateShort(pickedDate)} — change`}
                </ThemedText>
              </Pressable>

              {isPickerOpen ? (
                <DateTimePicker
                  value={fromLocalDateString(pickedDate ?? toLocalDateString(new Date()))}
                  mode="date"
                  display={Platform.OS === 'ios' ? 'inline' : 'default'}
                  onChange={onDateChange}
                />
              ) : null}

              {pickedDate !== null ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setPickedDate(null);
                    setIsPickerOpen(false);
                  }}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Clear date and use the text above
                  </ThemedText>
                </Pressable>
              ) : null}
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={!canSearch}
              onPress={() => void search()}
              style={({ pressed }) => [
                styles.primaryButton,
                {
                  backgroundColor: theme.accent,
                  opacity: !canSearch ? 0.4 : pressed ? 0.8 : 1,
                },
              ]}>
              {phase.kind === 'searching' ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <ThemedText type="default" style={styles.primaryLabel}>
                  Find flight
                </ThemedText>
              )}
            </Pressable>

            {error !== null ? (
              <View style={[styles.notice, { backgroundColor: theme.criticalSurface }]}>
                <ThemedText type="small" style={{ color: theme.criticalText }}>
                  {error}
                </ThemedText>
              </View>
            ) : null}

            {phase.kind === 'results' && phase.candidates.length === 0 ? (
              <View style={styles.section}>
                <ThemedText type="smallBold">No flight found</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  Check the number and the date. A flight that has not been scheduled yet, or one
                  that already landed days ago, will not come back.
                </ThemedText>
                <Pressable accessibilityRole="button" onPress={() => void search()}>
                  <ThemedText type="smallBold" style={{ color: theme.accent }}>
                    Try again
                  </ThemedText>
                </Pressable>
              </View>
            ) : null}

            {phase.kind === 'results' && phase.candidates.length > 1 ? (
              <View style={styles.section}>
                <ThemedText type="smallBold">Which leg?</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  This number operates more than once that day.
                </ThemedText>
                {phase.candidates.map((candidate, index) => (
                  <CandidateRow
                    key={`${candidate.originIata}-${candidate.destinationIata}-${index}`}
                    candidate={candidate}
                    onPress={() => setPhase({ kind: 'confirm', candidate })}
                  />
                ))}
              </View>
            ) : null}

            {phase.kind === 'confirm' || phase.kind === 'adding' ? (
              <View style={styles.section}>
                <ThemedText type="smallBold">Is this your flight?</ThemedText>
                <FlightCard data={cardDataFromCandidate(phase.candidate)} />
                <Pressable
                  accessibilityRole="button"
                  disabled={phase.kind === 'adding'}
                  onPress={() => void confirm(phase.candidate)}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    {
                      backgroundColor: theme.accent,
                      opacity: phase.kind === 'adding' ? 0.6 : pressed ? 0.8 : 1,
                    },
                  ]}>
                  {phase.kind === 'adding' ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <ThemedText type="default" style={styles.primaryLabel}>
                      Add to my flights
                    </ThemedText>
                  )}
                </Pressable>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

/** `DL 1234 · Mar 12 · JFK → LAX · 3:45 PM EDT` (§3.1 step 3). */
function CandidateRow({
  candidate,
  onPress,
}: {
  candidate: FlightCandidate;
  onPress: () => void;
}) {
  const theme = useTheme();

  const parts = [
    formatDesignator(candidate.marketingCarrierIata, candidate.marketingFlightNumber),
    formatLocalDateShort(candidate.departureDateLocal),
    `${candidate.originIata} → ${candidate.destinationIata}`,
    candidate.scheduledDepartureUtc !== null
      ? formatAirportLocal(candidate.scheduledDepartureUtc, candidate.originTz)
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.candidateRow,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: theme.border,
        },
      ]}>
      <ThemedText type="default">{parts.join(' · ')}</ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.three,
    gap: Spacing.four,
  },
  field: {
    gap: Spacing.two,
  },
  input: {
    height: 50,
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    fontSize: 18,
  },
  section: {
    gap: Spacing.two,
  },
  notice: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  candidateRow: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
  },
  primaryButton: {
    height: 50,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
