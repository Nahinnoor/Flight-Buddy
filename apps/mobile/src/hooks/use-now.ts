/**
 * The current time, refreshed every `intervalMs`. For screens whose text is
 * derived from "now" at minute granularity (group countdowns, Profile stats);
 * the pinned flight card keeps its own finer-grained clock (`useCountdown`).
 */
import { useEffect, useState } from 'react';

/** Dashboard and Groups tabs tick every 30 s; the Profile tab and flight log every 60 s. */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
