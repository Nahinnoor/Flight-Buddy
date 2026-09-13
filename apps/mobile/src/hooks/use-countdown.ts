/**
 * A live countdown to a UTC instant.
 *
 * The only state is "what time is it"; the countdown itself is derived during
 * render. That keeps the effect to its actual job — subscribing to the clock —
 * rather than pushing a computed value back into state on every tick.
 *
 * The cadence matches the magnitude (`countdownTickMs`): once a second inside
 * the last hour, every thirty seconds before that. A flight three days out
 * redrawing 86,400 times would spend battery on a number that changes hourly.
 */
import { useEffect, useState } from 'react';

import { countdownTickMs, countdownTo, type Countdown } from '@/lib/flight-display';

export function useCountdown(targetUtc: string | null): Countdown | null {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (targetUtc === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    // Each tick schedules the next from the value it just read, so the cadence
    // tightens by itself as departure approaches — no interval to swap out.
    const schedule = () => {
      const remaining = countdownTo(targetUtc)?.remainingMs ?? null;
      timer = setTimeout(() => {
        setNowMs(Date.now());
        schedule();
      }, countdownTickMs(remaining));
    };

    schedule();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [targetUtc]);

  return countdownTo(targetUtc, new Date(nowMs));
}
