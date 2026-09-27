/**
 * Market operations console state: filters, selection, bulk actions, audit.
 *
 * Bulk actions are *not* optimistic: the table keeps showing the status from
 * the feed. The server applies the hold, the feed broadcasts market_status,
 * and only then does the row change. The action result (affected/skipped)
 * and the audit trail are shown from the REST response.
 */
import { create } from 'zustand';
import { OpsActionRequest, type AuditEntry, type MarketStatus, type OpsAction, type OpsActionResponse } from '@live-betslip/protocol';
import { fetchAudit as defaultFetchAudit, opsAction as defaultOpsAction } from '../api/http';
import { defaultThresholds, type AnomalyThresholds } from '../domain/anomalies';

export type StatusFilter = 'all' | MarketStatus;

export interface OpsStore {
  text: string;
  status: StatusFilter;
  onlyAnomalies: boolean;
  thresholds: AnomalyThresholds;
  selected: Record<string, true>;
  reason: string;
  actor: string;
  pending: OpsAction | null;
  lastResult: OpsActionResponse | null;
  error: string | null;
  audit: AuditEntry[];
  auditError: string | null;
  hideSystemAudit: boolean;
}

export const initialOps = (): OpsStore => ({
  text: '',
  status: 'all',
  onlyAnomalies: false,
  thresholds: defaultThresholds,
  selected: {},
  reason: '',
  actor: 'trader-1',
  pending: null,
  lastResult: null,
  error: null,
  audit: [],
  auditError: null,
  hideSystemAudit: false,
});

export const useOpsStore = create<OpsStore>()(() => initialOps());
const set = useOpsStore.setState;
const get = useOpsStore.getState;

let api = { opsAction: defaultOpsAction, fetchAudit: defaultFetchAudit };

/** Test seam. */
export function setOpsApi(impl: Partial<typeof api>): void {
  api = { ...api, ...impl };
}

/** Client-side mirror of the server rule, so the button can explain itself. */
export function validateOpsRequest(marketIds: string[], reason: string, actor: string): string | null {
  const r = OpsActionRequest.safeParse({ marketIds, reason, actor });
  if (r.success) return null;
  if (marketIds.length === 0) return 'Выберите хотя бы один рынок';
  if (reason.trim().length < 5) return 'Укажите причину (минимум 5 символов)';
  return 'Некорректный запрос';
}

export const opsActions = {
  setText: (text: string) => set({ text }),
  setStatus: (status: StatusFilter) => set({ status }),
  setOnlyAnomalies: (onlyAnomalies: boolean) => set({ onlyAnomalies }),
  setThresholds: (t: Partial<AnomalyThresholds>) => set((s) => ({ thresholds: { ...s.thresholds, ...t } })),
  setReason: (reason: string) => set({ reason }),
  setActor: (actor: string) => set({ actor }),
  setHideSystemAudit: (hideSystemAudit: boolean) => set({ hideSystemAudit }),
  toggleSelected(id: string) {
    set((s) => {
      const selected = { ...s.selected };
      if (selected[id]) delete selected[id];
      else selected[id] = true;
      return { selected };
    });
  },
  setSelectedMany(ids: readonly string[], on: boolean) {
    set((s) => {
      const selected = { ...s.selected };
      for (const id of ids) {
        if (on) selected[id] = true;
        else delete selected[id];
      }
      return { selected };
    });
  },
  clearSelection: () => set({ selected: {} }),

  async submit(action: OpsAction): Promise<void> {
    const { selected, reason, actor, pending } = get();
    if (pending) return;
    const marketIds = Object.keys(selected);
    const invalid = validateOpsRequest(marketIds, reason, actor);
    if (invalid) {
      set({ error: invalid });
      return;
    }
    set({ pending: action, error: null });
    try {
      const res = await api.opsAction(action, { marketIds, reason: reason.trim(), actor });
      set({ lastResult: res, pending: null, selected: {}, reason: '' });
    } catch (err) {
      set({ pending: null, error: (err as Error).message });
    }
    await opsActions.loadAudit();
  },

  async loadAudit(): Promise<void> {
    try {
      const audit = await api.fetchAudit(300);
      set({ audit, auditError: null });
    } catch (err) {
      set({ auditError: (err as Error).message });
    }
  },
};
