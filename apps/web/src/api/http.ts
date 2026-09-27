/**
 * REST client. Every response body is validated against the shared contract.
 * Network failures and 5xx raise `ApiRequestError` with `retryable = true`:
 * the caller may retry *with the same idempotency key*.
 */
import {
  ApiError,
  AuditListResponse,
  ChaosState,
  OpsActionResponse,
  PlaceBetResponse,
  type AuditEntry,
  type ChaosUpdate,
  type OpsAction,
  type OpsActionRequest,
  type PlaceBetRequest,
} from '@live-betslip/protocol';
import type { z } from 'zod';
import { config } from '../config';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export type Fetch = typeof fetch;

async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init: RequestInit,
  fetchImpl: Fetch,
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetchImpl(config.apiBase + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiRequestError(`Сеть недоступна: ${(err as Error).message}`, null, true);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fallthrough: handled below
  }
  if (!res.ok) {
    const e = ApiError.safeParse(body);
    throw new ApiRequestError(
      e.success ? e.data.message : `HTTP ${res.status}`,
      res.status,
      res.status >= 500,
      e.success ? e.data.error : null,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiRequestError('Ответ сервера не соответствует контракту', res.status, false, 'CONTRACT');
  return parsed.data;
}

export function placeBet(req: PlaceBetRequest, fetchImpl: Fetch = fetch) {
  return request(PlaceBetResponse, '/api/bets', { method: 'POST', body: JSON.stringify(req) }, fetchImpl);
}

export function opsAction(action: OpsAction, req: OpsActionRequest, fetchImpl: Fetch = fetch) {
  return request(OpsActionResponse, `/api/ops/${action}`, { method: 'POST', body: JSON.stringify(req) }, fetchImpl);
}

export async function fetchAudit(limit = 200, fetchImpl: Fetch = fetch): Promise<AuditEntry[]> {
  const r = await request(AuditListResponse, `/api/ops/audit?limit=${limit}`, { method: 'GET' }, fetchImpl);
  return r.entries;
}

export function getChaos(fetchImpl: Fetch = fetch) {
  return request(ChaosState, '/api/chaos', { method: 'GET' }, fetchImpl);
}

export function setChaos(update: ChaosUpdate, fetchImpl: Fetch = fetch) {
  return request(ChaosState, '/api/chaos', { method: 'PUT', body: JSON.stringify(update) }, fetchImpl);
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
