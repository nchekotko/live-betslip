import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaceBetRequest, PlaceBetResponse } from '@live-betslip/protocol';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { EventList } from '../src/components/EventList';
import { BetSlip } from '../src/components/slip/BetSlip';
import { OpsConsole } from '../src/components/ops/OpsConsole';
import { computeVisibleRange } from '../src/components/VirtualList';
import { feedActions, useFeedStore } from '../src/store/feedStore';
import { initialOps, setOpsApi, useOpsStore } from '../src/store/opsStore';
import { initialSlip, setPlaceBetImpl, useSlipStore } from '../src/store/slipStore';
import { snapshot } from './fixtures';

const HOME = 'ev-1:1x2:home';

function goLive(seq = 10) {
  feedActions.reset();
  feedActions.snapshot(snapshot(seq), Date.now());
  feedActions.status('live', { attempt: 0, nextRetryAt: null });
}

function priceTick(seq: number, price: number, version: number) {
  act(() => {
    feedActions.deltas([{ type: 'price', seq, ts: Date.now(), marketId: 'ev-1:1x2', selectionId: HOME, price, priceVersion: version }], Date.now());
  });
}

beforeEach(() => {
  useSlipStore.setState(initialSlip(), true);
  useOpsStore.setState(initialOps(), true);
  goLive();
});

describe('EventList + PriceButton', () => {
  it('renders prices, flashes direction on change and adds a selection to the slip', async () => {
    const user = userEvent.setup();
    render(<EventList />);
    const btn = screen.getByTestId(`price-${HOME}`);
    expect(btn).toHaveAccessibleName('П1: 2.10');
    priceTick(11, 2.3, 2);
    expect(btn).toHaveAccessibleName('П1: 2.30, вырос');
    expect(btn.querySelector('.flash-up')).not.toBeNull();
    priceTick(12, 2.2, 3);
    expect(btn.querySelector('.flash-down')).not.toBeNull();

    await user.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(useSlipStore.getState().legs[0]).toMatchObject({ selectionId: HOME, price: 2.2, priceVersion: 3 });
  });

  it('disables prices of a suspended market and renders the state explicitly', () => {
    render(<EventList />);
    act(() => {
      feedActions.deltas(
        [{ type: 'market_status', seq: 11, ts: Date.now(), marketId: 'ev-1:1x2', status: 'suspended', suspendReason: 'goal 1-0', cashOutAvailable: false }],
        Date.now(),
      );
    });
    expect(screen.getByTestId(`price-${HOME}`)).toBeDisabled();
    expect(screen.getByRole('group', { name: 'Исход матча: Приостановлен' })).toBeInTheDocument();
    expect(screen.getAllByText(/Приостановлен: goal 1-0/)).toHaveLength(1);
  });

  it('supports arrow-key navigation across the price grid', async () => {
    const user = userEvent.setup();
    render(<EventList />);
    screen.getByTestId(`price-${HOME}`).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('price-ev-1:1x2:draw')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-nav-row')).toBe('1');
  });
});

describe('BetSlip requote flow', () => {
  function addHome() {
    const s = useFeedStore.getState().selections[HOME];
    if (!s) throw new Error('fixture');
    useSlipStore.setState({
      legs: [
        {
          selectionId: HOME,
          marketId: 'ev-1:1x2',
          eventId: 'ev-1',
          eventName: 'Northbridge — Riverside',
          marketName: 'Исход матча',
          selectionName: 'П1',
          price: s.price,
          priceVersion: s.priceVersion,
          stake: '10',
        },
      ],
    });
  }

  it('never places at a changed price without explicit acceptance', async () => {
    const user = userEvent.setup();
    const sent: PlaceBetRequest[] = [];
    setPlaceBetImpl(async (req) => {
      sent.push(req);
      const res: PlaceBetResponse = {
        status: 'accepted',
        betId: 'bet-1',
        betType: req.betType,
        stake: req.stake,
        legs: req.legs,
        combinedPrice: req.legs[0]?.price ?? 1.01,
        potentialReturn: req.stake * (req.legs[0]?.price ?? 1.01),
        acceptedAt: Date.now(),
      };
      return res;
    });
    addHome();
    render(<BetSlip />);
    const place = screen.getByRole('button', { name: /Сделать ставки/ });
    expect(place).toBeEnabled();

    priceTick(11, 1.95, 2);
    expect(place).toBeDisabled();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/Коэффициенты изменились/)).toBeInTheDocument();
    expect(screen.getByTestId('slip-live')).toHaveTextContent('П1: коэффициент 2.10 → 1.95');

    await user.click(within(alert).getByRole('button', { name: 'Принять новые коэффициенты' }));
    expect(place).toBeEnabled();
    await user.click(place);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.legs[0]).toMatchObject({ price: 1.95, priceVersion: 2 });
    expect(sent[0]?.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(await screen.findByTestId('placement-accepted')).toBeInTheDocument();
    expect(useSlipStore.getState().legs).toHaveLength(0);
  });

  it('with "accept higher odds" an upward move does not block', async () => {
    addHome();
    useSlipStore.setState({ acceptHigherOdds: true });
    render(<BetSlip />);
    priceTick(11, 2.4, 2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /Сделать ставки/ })).toBeEnabled();
  });

  it('server PRICE_CHANGED rejection forces a requote; network error keeps the idempotency key on retry', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let call = 0;
    setPlaceBetImpl(async (req) => {
      keys.push(req.idempotencyKey);
      call += 1;
      if (call === 1) {
        return {
          status: 'rejected',
          reason: 'PRICE_CHANGED',
          message: 'moved',
          quotes: [{ marketId: 'ev-1:1x2', selectionId: HOME, price: 2.0, priceVersion: 5, marketStatus: 'open' }],
          rejectedAt: Date.now(),
        };
      }
      if (call === 2) throw new (await import('../src/api/http')).ApiRequestError('Сеть недоступна', null, true);
      return {
        status: 'accepted',
        betId: 'bet-2',
        betType: 'single',
        stake: req.stake,
        legs: req.legs,
        combinedPrice: 2,
        potentialReturn: 20,
        acceptedAt: Date.now(),
      };
    });
    addHome();
    render(<BetSlip />);
    await user.click(screen.getByRole('button', { name: /Сделать ставки/ }));
    expect(await screen.findByTestId('placement-rejected')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('2.10 → 2.00');
    await user.click(within(alert).getByRole('button', { name: 'Принять новые коэффициенты' }));
    expect(useSlipStore.getState().legs[0]).toMatchObject({ price: 2.0, priceVersion: 5 });

    await user.click(screen.getByRole('button', { name: /Сделать ставки/ }));
    expect(await screen.findByTestId('placement-error')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Повторить/ }));
    expect(await screen.findByTestId('placement-accepted')).toBeInTheDocument();
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('disables placement while the feed is disconnected', () => {
    addHome();
    render(<BetSlip />);
    act(() => feedActions.status('reconnecting', { attempt: 1, nextRetryAt: Date.now() + 1000 }));
    expect(screen.getByRole('button', { name: /Сделать ставки/ })).toBeDisabled();
    expect(screen.getByText(/приём ставок приостановлен/)).toBeInTheDocument();
  });
});

describe('ConnectionBanner', () => {
  const base = { connection: 'live' as const, stale: false, staleForMs: 0, healthy: true, nextRetryAt: null, reconnectAttempt: 0, now: 0 };
  it('is hidden when healthy and explicit in degraded modes', () => {
    const { container, rerender } = render(<ConnectionBanner health={base} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ConnectionBanner health={{ ...base, stale: true, staleForMs: 5200, healthy: false }} />);
    expect(screen.getByTestId('connection-banner')).toHaveTextContent('Фид не обновлялся 5 с');
    rerender(<ConnectionBanner health={{ ...base, connection: 'reconnecting', healthy: false, nextRetryAt: 2000, reconnectAttempt: 3 }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('через 2 с (попытка 3)');
  });
});

describe('OpsConsole', () => {
  it('bulk suspend requires a reason and writes to the audit trail', async () => {
    const user = userEvent.setup();
    const opsAction = vi.fn(async (action: 'suspend' | 'resume', req: { marketIds: string[]; reason: string; actor: string }) => ({
      auditId: 'audit-1',
      action,
      affected: req.marketIds,
      skipped: [],
    }));
    const fetchAudit = vi.fn(async () => [
      { id: 'audit-1', ts: Date.now(), actor: 'trader-1', action: 'suspend' as const, marketIds: ['ev-1:1x2'], reason: 'integrity alert' },
    ]);
    setOpsApi({ opsAction, fetchAudit });
    render(<OpsConsole />);

    await user.click(within(screen.getByTestId('ops-row-ev-1:1x2')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('ops-row-ev-2:1x2')).getByRole('checkbox'));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('2');
    const suspend = screen.getByRole('button', { name: 'Приостановить' });
    expect(suspend).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/integrity alert/), 'abc');
    expect(suspend).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/integrity alert/), 'de fraud');
    expect(suspend).toBeEnabled();
    await user.click(suspend);

    expect(opsAction).toHaveBeenCalledWith('suspend', { marketIds: ['ev-1:1x2', 'ev-2:1x2'], reason: 'abcde fraud', actor: 'trader-1' });
    expect(await screen.findByText('integrity alert')).toBeInTheDocument();
    expect(screen.getByTestId('selected-count')).toHaveTextContent('0');
  });

  it('filters by text and highlights anomalies', async () => {
    const user = userEvent.setup();
    setOpsApi({ fetchAudit: async () => [] });
    render(<OpsConsole />);
    priceTick(11, 3.0, 2); // +43% jump
    expect(screen.getByTestId('ops-row-ev-1:1x2')).toHaveClass('ops-row--jump');
    await user.type(screen.getByPlaceholderText(/команда/), 'kingsfield');
    expect(screen.queryByTestId('ops-row-ev-1:1x2')).toBeNull();
    expect(screen.getByTestId('ops-row-ev-2:1x2')).toBeInTheDocument();
  });
});

describe('computeVisibleRange', () => {
  it('windows a long list with overscan', () => {
    expect(computeVisibleRange(0, 400, 40, 1000, 2)).toEqual({ start: 0, end: 13 });
    expect(computeVisibleRange(4000, 400, 40, 1000, 2)).toEqual({ start: 98, end: 113 });
    expect(computeVisibleRange(1e6, 400, 40, 1000, 2).end).toBe(1000);
  });
});
