/**
 * Exponential backoff with "equal jitter": half of the exponential window is
 * fixed, half is random. Keeps a floor (no hammering the server) while
 * de-synchronising clients after a mass disconnect (no thundering herd).
 */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const defaultBackoff: BackoffOptions = { baseMs: 500, maxMs: 15_000 };

export function backoffDelay(attempt: number, random: () => number, opts: BackoffOptions = defaultBackoff): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}
