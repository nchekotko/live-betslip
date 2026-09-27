/**
 * Zustand store for the live feed.
 *
 * Why zustand (not Redux Toolkit): the hot path is ~100 deltas/s. Components
 * subscribe to a single entity (`s.selections[id]`), so a price tick re-renders
 * one button. The WebSocket client writes to the store from outside React via
 * `setState`, once per animation frame, without actions/dispatch boilerplate.
 * All state transitions live in the pure reducers of feedReducer.ts.
 */
import { create } from 'zustand';
import type { DeltaMsg, SnapshotMsg } from '@live-betslip/protocol';
import type { ConnectionStatus, StatusInfo } from '../feed/feedClient';
import { applyDeltas, applySnapshot, emptyFeed, type FeedData } from './feedReducer';

export interface FeedStore extends FeedData {
  connection: ConnectionStatus;
  reconnectAttempt: number;
  nextRetryAt: number | null;
  /** True once the first snapshot has been applied. */
  hydrated: boolean;
}

export const initialFeedStore: FeedStore = {
  ...emptyFeed,
  connection: 'idle',
  reconnectAttempt: 0,
  nextRetryAt: null,
  hydrated: false,
};

export const useFeedStore = create<FeedStore>()(() => initialFeedStore);

export const feedActions = {
  snapshot(msg: SnapshotMsg, now: number) {
    useFeedStore.setState((s) => ({ ...applySnapshot(s, msg, now), hydrated: true }));
  },
  deltas(deltas: DeltaMsg[], now: number) {
    useFeedStore.setState((s) => applyDeltas(s, deltas, now));
  },
  status(connection: ConnectionStatus, info: StatusInfo) {
    useFeedStore.setState({ connection, reconnectAttempt: info.attempt, nextRetryAt: info.nextRetryAt });
  },
  heartbeat(now: number) {
    useFeedStore.setState({ lastMessageAt: now });
  },
  reset() {
    useFeedStore.setState(initialFeedStore, true);
  },
};
