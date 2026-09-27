/** Wires the FeedClient to the stores. One connection per app. */
import { config } from '../config';
import { feedActions, useFeedStore } from '../store/feedStore';
import { slipActions } from '../store/slipStore';
import { FeedClient } from './feedClient';

let client: FeedClient | null = null;

export function getFeedClient(): FeedClient | null {
  return client;
}

export function startFeed(url: string = config.feedUrl): () => void {
  const c = new FeedClient({
    url,
    handlers: {
      onSnapshot: (msg, now) => feedActions.snapshot(msg, now),
      onDeltas: (deltas, now) => feedActions.deltas(deltas, now),
      onStatus: (status, info) => feedActions.status(status, info),
      onHeartbeat: (now) => feedActions.heartbeat(now),
    },
  });
  client = c;
  // "Accept higher odds": follow upward moves for slip legs as prices arrive.
  const unsubscribe = useFeedStore.subscribe((s, prev) => {
    if (s.selections !== prev.selections) slipActions.followHigherOdds(s);
  });
  c.start();
  return () => {
    unsubscribe();
    c.stop();
    if (client === c) client = null;
  };
}
