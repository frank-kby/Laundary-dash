// Thin fetch wrapper. Session lives in an HttpOnly cookie the browser sends automatically;
// nothing auth-related is ever stored in localStorage.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

type Opts = { idempotencyKey?: string; signal?: AbortSignal; form?: FormData };

let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: () => void) => (onUnauthenticated = fn);

export async function api<T = any>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false && method !== 'GET') {
    throw new ApiError(0, 'OFFLINE', 'offline');
  }
  const headers: Record<string, string> = { 'X-Requested-With': 'LaundryDash', Accept: 'application/json' };
  if (body !== undefined && !opts.form) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, navigator.onLine === false ? 'OFFLINE' : 'NETWORK', 'network');
  }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/me') onUnauthenticated?.();
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'HTTP_' + res.status, err.message ?? 'Request failed', err.details);
  }
  return data as T;
}

export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>('GET', p, undefined, { signal });
export const post = <T = any>(p: string, b?: unknown, key?: string) => api<T>('POST', p, b ?? {}, { idempotencyKey: key });
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b);
export const del = (p: string) => api('DELETE', p);

export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
