import { useEffect, useState } from 'react';

/** Re-renders the caller every `intervalMs` with the current time. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Re-renders once when wall-clock time reaches `until` (if in the future). */
export function useRerenderAt(until: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (until === null) return;
    const wait = until - Date.now();
    if (wait <= 0) return;
    const id = setTimeout(() => setTick((t) => t + 1), wait + 16);
    return () => clearTimeout(id);
  }, [until]);
}
