/**
 * Shared contract between the odds server and the web client.
 *
 * Every message that crosses the wire is described here as a zod schema.
 * The server validates its own output in contract tests; the client parses
 * every inbound frame with `ServerMessage.safeParse` and drops anything
 * that does not match (counted as `invalid` in telemetry).
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Domain primitives
// ---------------------------------------------------------------------------

/** Decimal odds. 1.01 is the lowest price the book ever offers. */
export const Price = z.number().gte(1.01).lte(1000);

export const MarketStatus = z.enum(['open', 'suspended', 'closed', 'settled']);
export type MarketStatus = z.infer<typeof MarketStatus>;

export const MarketKind = z.enum(['match_result', 'total_goals', 'btts']);
export type MarketKind = z.infer<typeof MarketKind>;

export const EventStatus = z.enum(['live', 'ended']);
export type EventStatus = z.infer<typeof EventStatus>;

export const SelectionResult = z.enum(['win', 'lose']);

export const Score = z.object({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
});
export type Score = z.infer<typeof Score>;

export const Selection = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: Price,
  /** Monotonic per selection; bumps on every price change. Used for requote checks. */
  priceVersion: z.number().int().nonnegative(),
  result: SelectionResult.nullable(),
});
export type Selection = z.infer<typeof Selection>;

export const Market = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  name: z.string().min(1),
  kind: MarketKind,
  status: MarketStatus,
  suspendReason: z.string().nullable(),
  cashOutAvailable: z.boolean(),
  selections: z.array(Selection).min(2),
  /** Server time (ms) of the last change to this market. */
  updatedAt: z.number().int().nonnegative(),
});
export type Market = z.infer<typeof Market>;

export const SportEvent = z.object({
  id: z.string().min(1),
  competition: z.string().min(1),
  home: z.string().min(1),
  away: z.string().min(1),
  score: Score,
  minute: z.number().int().min(0).max(130),
  status: EventStatus,
});
export type SportEvent = z.infer<typeof SportEvent>;

// ---------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------

const Seq = z.number().int().positive();
const Ts = z.number().int().nonnegative();

export const HelloMsg = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  serverTime: Ts,
  heartbeatMs: z.number().int().positive(),
});

/** Full state at feed position `seq`. Client resets its sequencer to `seq`. */
export const SnapshotMsg = z.object({
  type: z.literal('snapshot'),
  seq: z.number().int().nonnegative(),
  ts: Ts,
  events: z.array(SportEvent),
  markets: z.array(Market),
});
export type SnapshotMsg = z.infer<typeof SnapshotMsg>;

export const PriceMsg = z.object({
  type: z.literal('price'),
  seq: Seq,
  ts: Ts,
  marketId: z.string().min(1),
  selectionId: z.string().min(1),
  price: Price,
  priceVersion: z.number().int().nonnegative(),
});

export const MarketStatusMsg = z.object({
  type: z.literal('market_status'),
  seq: Seq,
  ts: Ts,
  marketId: z.string().min(1),
  status: MarketStatus,
  suspendReason: z.string().nullable(),
  cashOutAvailable: z.boolean(),
});

export const EventUpdateMsg = z.object({
  type: z.literal('event_update'),
  seq: Seq,
  ts: Ts,
  eventId: z.string().min(1),
  score: Score,
  minute: z.number().int().min(0).max(130),
  status: EventStatus,
});

export const SettleMsg = z.object({
  type: z.literal('settle'),
  seq: Seq,
  ts: Ts,
  marketId: z.string().min(1),
  winningSelectionId: z.string().min(1),
});

export const EventAddedMsg = z.object({
  type: z.literal('event_added'),
  seq: Seq,
  ts: Ts,
  event: SportEvent,
  markets: z.array(Market),
});

export const EventRemovedMsg = z.object({
  type: z.literal('event_removed'),
  seq: Seq,
  ts: Ts,
  eventId: z.string().min(1),
});

/** Sequenced feed deltas. Exactly one seq per delta, gap-free on the server side. */
export const DeltaMsg = z.discriminatedUnion('type', [
  PriceMsg,
  MarketStatusMsg,
  EventUpdateMsg,
  SettleMsg,
  EventAddedMsg,
  EventRemovedMsg,
]);
export type DeltaMsg = z.infer<typeof DeltaMsg>;
export type DeltaType = DeltaMsg['type'];

/** Liveness + feed head. `seq` is the latest published seq (not a delta itself). */
export const HeartbeatMsg = z.object({
  type: z.literal('heartbeat'),
  seq: z.number().int().nonnegative(),
  ts: Ts,
});

export const ErrorMsg = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});

export const ServerMessage = z.discriminatedUnion('type', [
  HelloMsg,
  SnapshotMsg,
  PriceMsg,
  MarketStatusMsg,
  EventUpdateMsg,
  SettleMsg,
  EventAddedMsg,
  EventRemovedMsg,
  HeartbeatMsg,
  ErrorMsg,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

const DELTA_TYPES: ReadonlySet<string> = new Set<DeltaType>([
  'price',
  'market_status',
  'event_update',
  'settle',
  'event_added',
  'event_removed',
]);

export function isDelta(msg: ServerMessage): msg is DeltaMsg {
  return DELTA_TYPES.has(msg.type);
}

// ---------------------------------------------------------------------------
// Client -> server messages
// ---------------------------------------------------------------------------

/**
 * `lastSeq` = last contiguous seq the client applied (null on first connect).
 * The server replays from its ring buffer if it still has everything after
 * `lastSeq`, otherwise it sends a fresh snapshot.
 */
export const SubscribeMsg = z.object({
  type: z.literal('subscribe'),
  lastSeq: z.number().int().nonnegative().nullable(),
});

/** Explicit request for a snapshot (client detected an unrecoverable gap). */
export const ResyncMsg = z.object({
  type: z.literal('resync'),
});

export const ClientMessage = z.discriminatedUnion('type', [SubscribeMsg, ResyncMsg]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// REST: bet placement
// ---------------------------------------------------------------------------

export const STAKE_MIN = 0.1;
export const STAKE_MAX = 10_000;
export const MAX_POTENTIAL_RETURN = 250_000;
export const MAX_ACCA_LEGS = 12;

export const BetType = z.enum(['single', 'acca']);
export type BetType = z.infer<typeof BetType>;

export const BetLegRequest = z.object({
  marketId: z.string().min(1),
  selectionId: z.string().min(1),
  /** Price the user saw and confirmed. */
  price: Price,
  /** Version of that price. Server rejects with PRICE_CHANGED if it moved (see README). */
  priceVersion: z.number().int().nonnegative(),
});
export type BetLegRequest = z.infer<typeof BetLegRequest>;

export const PlaceBetRequest = z.object({
  /** Client-generated; retries of the same attempt reuse it. */
  idempotencyKey: z.string().min(8).max(64),
  betType: BetType,
  stake: z.number().gte(STAKE_MIN).lte(STAKE_MAX),
  legs: z.array(BetLegRequest).min(1).max(MAX_ACCA_LEGS),
  acceptHigherOdds: z.boolean(),
});
export type PlaceBetRequest = z.infer<typeof PlaceBetRequest>;

export const RejectReason = z.enum([
  'PRICE_CHANGED',
  'MARKET_SUSPENDED',
  'MARKET_CLOSED',
  'SELECTION_NOT_FOUND',
  'INVALID_COMBINATION',
  'LIMIT_EXCEEDED',
]);
export type RejectReason = z.infer<typeof RejectReason>;

export const Quote = z.object({
  marketId: z.string().min(1),
  selectionId: z.string().min(1),
  price: Price.nullable(),
  priceVersion: z.number().int().nonnegative().nullable(),
  marketStatus: MarketStatus.nullable(),
});
export type Quote = z.infer<typeof Quote>;

export const AcceptedBet = z.object({
  status: z.literal('accepted'),
  betId: z.string().min(1),
  betType: BetType,
  stake: z.number().positive(),
  legs: z.array(BetLegRequest).min(1),
  combinedPrice: z.number().gte(1.01),
  potentialReturn: z.number().positive(),
  acceptedAt: Ts,
});
export type AcceptedBet = z.infer<typeof AcceptedBet>;

export const RejectedBet = z.object({
  status: z.literal('rejected'),
  reason: RejectReason,
  message: z.string(),
  /** Current server-side quotes for every leg, so the client can requote. */
  quotes: z.array(Quote),
  rejectedAt: Ts,
});
export type RejectedBet = z.infer<typeof RejectedBet>;

export const PlaceBetResponse = z.discriminatedUnion('status', [AcceptedBet, RejectedBet]);
export type PlaceBetResponse = z.infer<typeof PlaceBetResponse>;

export const ApiError = z.object({
  error: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------------------
// REST: market operations (internal)
// ---------------------------------------------------------------------------

export const OpsAction = z.enum(['suspend', 'resume']);
export type OpsAction = z.infer<typeof OpsAction>;

export const OpsActionRequest = z.object({
  marketIds: z.array(z.string().min(1)).min(1).max(1000),
  reason: z.string().trim().min(5, 'reason must be at least 5 characters').max(200),
  actor: z.string().trim().min(1).max(64),
});
export type OpsActionRequest = z.infer<typeof OpsActionRequest>;

export const OpsActionResponse = z.object({
  auditId: z.string().min(1),
  action: OpsAction,
  affected: z.array(z.string()),
  skipped: z.array(z.object({ marketId: z.string(), reason: z.string() })),
});
export type OpsActionResponse = z.infer<typeof OpsActionResponse>;

export const AuditAction = z.enum(['suspend', 'resume', 'auto_suspend', 'auto_resume', 'settle']);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntry = z.object({
  id: z.string().min(1),
  ts: Ts,
  actor: z.string().min(1),
  action: AuditAction,
  marketIds: z.array(z.string()),
  reason: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditListResponse = z.object({
  entries: z.array(AuditEntry),
});

// ---------------------------------------------------------------------------
// REST: chaos controls for the mock feed (demo only)
// ---------------------------------------------------------------------------

export const ChaosConfig = z.object({
  /** Probability that a delta is sent twice. */
  duplicateRate: z.number().min(0).max(1),
  /** Probability that a delta is held back and sent after the next one. */
  reorderRate: z.number().min(0).max(1),
  /** Probability that a delta is silently dropped (forces a gap -> resync). */
  gapRate: z.number().min(0).max(1),
  /** Mean time between forced disconnects per client; 0 disables. */
  disconnectMeanMs: z.number().int().min(0),
});
export type ChaosConfig = z.infer<typeof ChaosConfig>;

export const ChaosUpdate = ChaosConfig.partial().extend({
  /** Stop sending anything (incl. heartbeats) for N ms: demonstrates stale feed. */
  freezeForMs: z.number().int().min(0).max(60_000).optional(),
});
export type ChaosUpdate = z.infer<typeof ChaosUpdate>;

export const ChaosState = ChaosConfig.extend({
  frozenUntil: Ts.nullable(),
});
export type ChaosState = z.infer<typeof ChaosState>;
