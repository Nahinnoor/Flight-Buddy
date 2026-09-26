/**
 * The current time, refreshed every `intervalMs`. For screens whose text is
 * derived from "now" at minute granularity (the dashboard's group
 * countdowns); the pinned flight card keeps its own finer-grained clock
 * (`useCountdown`).
 */
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
