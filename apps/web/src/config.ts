/** Runtime configuration. Defaults work with `npm run dev` (Vite proxies /api and /ws). */
function wsUrlFromLocation(): string {
  if (typeof location === 'undefined') return 'ws://127.0.0.1:8787/ws';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export const config = {
  feedUrl: (import.meta.env.VITE_FEED_URL as string | undefined) ?? wsUrlFromLocation(),
  apiBase: (import.meta.env.VITE_API_BASE as string | undefined) ?? '',
  /** Feed considered stale (degraded mode) after this long without any frame. */
  staleAfterMs: 3000,
  /** Recently-changed price highlight duration. */
  flashMs: 1200,
  /** "Repriced" badge after a suspension ends with new prices. */
  repricedBadgeMs: 5000,
};
