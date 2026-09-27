import { config } from '../config';
import type { ConnectionStatus } from '../feed/feedClient';
import { useFeedStore } from '../store/feedStore';
import { useNow } from './useNow';

export interface FeedHealth {
  connection: ConnectionStatus;
  stale: boolean;
  staleForMs: number;
  /** Safe to accept bets: connected, in sync and receiving frames. */
  healthy: boolean;
  nextRetryAt: number | null;
  reconnectAttempt: number;
  now: number;
}

export function computeHealth(
  connection: ConnectionStatus,
  lastMessageAt: number | null,
  now: number,
  staleAfterMs: number,
): { stale: boolean; staleForMs: number; healthy: boolean } {
  const staleForMs = lastMessageAt === null ? 0 : Math.max(0, now - lastMessageAt);
  const stale = connection === 'live' && lastMessageAt !== null && staleForMs > staleAfterMs;
  return { stale, staleForMs, healthy: connection === 'live' && !stale };
}

export function useFeedHealth(): FeedHealth {
  const now = useNow(500);
  const connection = useFeedStore((s) => s.connection);
  const lastMessageAt = useFeedStore((s) => s.lastMessageAt);
  const nextRetryAt = useFeedStore((s) => s.nextRetryAt);
  const reconnectAttempt = useFeedStore((s) => s.reconnectAttempt);
  return { connection, nextRetryAt, reconnectAttempt, now, ...computeHealth(connection, lastMessageAt, now, config.staleAfterMs) };
}
