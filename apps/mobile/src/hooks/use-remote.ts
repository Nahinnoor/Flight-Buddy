/**
 * One independently-loading piece of a screen: its data, its error, and a
 * `reload`. Each section of the signed-in screens owns one, so a failure in
 * one query shows up in that section alone.
 *
 * A response that arrives after a newer request was started is dropped, so a
 * slow first load cannot overwrite a fast pull-to-refresh.
 */
import { useCallback, useRef, useState } from 'react';

export interface Remote<T> {
  data: T | null;
  error: string | null;
  reload: () => Promise<void>;
}

export function useRemote<T>(
  fetcher: (() => Promise<T>) | null,
  fallbackMessage: string,
): Remote<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (fetcher === null) return;
    latest.current += 1;
    const request = latest.current;
    try {
      const value = await fetcher();
      if (request !== latest.current) return;
      setData(value);
      setError(null);
    } catch (caught) {
      if (request !== latest.current) return;
      setError(caught instanceof Error && caught.message !== '' ? caught.message : fallbackMessage);
    }
  }, [fetcher, fallbackMessage]);

  return { data, error, reload };
}
