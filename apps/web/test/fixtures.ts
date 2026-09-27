import type { Market, SnapshotMsg, SportEvent } from '@live-betslip/protocol';

export function market(eventId: string, key: string, prices: number[], status: Market['status'] = 'open'): Market {
  const names = key === '1x2' ? ['home', 'draw', 'away'] : ['over', 'under'];
  const id = `${eventId}:${key}`;
  return {
    id,
    eventId,
    name: key === '1x2' ? 'Исход матча' : 'Тотал 2.5',
    kind: key === '1x2' ? 'match_result' : 'total_goals',
    status,
    suspendReason: status === 'suspended' ? 'goal 1-0' : null,
    cashOutAvailable: status === 'open',
    selections: prices.map((p, i) => ({
      id: `${id}:${names[i]}`,
      name: key === '1x2' ? (['П1', 'X', 'П2'][i] ?? '?') : i === 0 ? 'ТБ 2.5' : 'ТМ 2.5',
      price: p,
      priceVersion: 1,
      result: null,
    })),
    updatedAt: 1000,
  };
}

export function event(id: string, home = 'Northbridge', away = 'Riverside'): SportEvent {
  return { id, competition: 'Mock Premier', home, away, score: { home: 0, away: 0 }, minute: 30, status: 'live' };
}

export function snapshot(seq = 10): SnapshotMsg {
  return {
    type: 'snapshot',
    seq,
    ts: 1000,
    events: [event('ev-1'), event('ev-2', 'Kingsfield', 'Ashford')],
    markets: [
      market('ev-1', '1x2', [2.1, 3.4, 3.2]),
      market('ev-1', 'ou25', [1.9, 1.9]),
      market('ev-2', '1x2', [1.5, 4.0, 6.0]),
    ],
  };
}
