import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError, get } from '../api';
import { useI18n } from '../i18n';

/** Loads a GET endpoint; exposes reload. Aborts on unmount. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const ctrl = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(null);
    try {
      setData(await get<T>(path, c.signal));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    load();
    return () => ctrl.current?.abort();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Translates API/network errors into plain, actionable text. */
export function useErrorText() {
  const { t } = useI18n();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'OFFLINE') return t('error.offline');
      if (e.code === 'NETWORK') return t('error.network');
      if (e.code === 'RATE_LIMITED') return t('error.rateLimited');
      if (e.status === 401 && e.code === 'UNAUTHENTICATED' && e.message === 'Please sign in.') return t('error.session');
      if (e.status >= 500) return t('error.server');
      return e.message;
    }
    return t('error.server');
  };
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const text = useErrorText();
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert">
      <p>{text(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok' | 'test'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Loading() {
  const { t } = useI18n();
  return (
    <p className="loading" role="status" aria-live="polite">
      {t('common.loading')}
    </p>
  );
}

type FieldProps = { label: string; hint?: string; error?: string; optional?: boolean };
function FieldWrap({ id, label, hint, error, optional, children }: FieldProps & { id: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {optional && <span className="optional"> ({t('common.optional')})</span>}
      </label>
      {children}
      {hint && !error && <p className="hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="field-error" id={`${id}-err`}>{error}</p>}
    </div>
  );
}

export function TextField({ label, hint, error, optional, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={label} hint={hint} error={error} optional={optional}>
      <input id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined} {...rest} />
    </FieldWrap>
  );
}

export function SelectField({ label, hint, error, optional, children, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={label} hint={hint} error={error} optional={optional}>
      <select id={id} aria-invalid={!!error} {...rest}>
        {children}
      </select>
    </FieldWrap>
  );
}

export function TextArea({ label, hint, error, optional, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldWrap id={id} label={label} hint={hint} error={error} optional={optional}>
      <textarea id={id} rows={3} {...rest} />
    </FieldWrap>
  );
}

export function Checkbox({ label, hint, checked, onChange, name }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; name?: string }) {
  const id = useId();
  return (
    <div className="check">
      <input type="checkbox" id={id} name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      </label>
    </div>
  );
}

export function Button({ busy, children, variant = 'primary', className = '', ...rest }: { busy?: boolean; variant?: 'primary' | 'secondary' | 'quiet' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${variant} ${className}`} disabled={busy || rest.disabled} aria-busy={busy || undefined} {...rest}>
      {children}
    </button>
  );
}

const PHASES = ['booked', 'collected', 'cleaning', 'ready', 'delivered'] as const;
export function phaseIndex(status: string): number {
  switch (status) {
    case 'PENDING_CONFIRMATION':
    case 'CONFIRMED':
    case 'PICKUP_SCHEDULED':
      return 0;
    case 'PICKED_UP':
    case 'RECEIVED':
    case 'INSPECTION_REQUIRED':
    case 'AWAITING_APPROVAL':
      return 1;
    case 'PROCESSING':
      return 2;
    case 'READY_FOR_DELIVERY':
    case 'OUT_FOR_DELIVERY':
      return 3;
    case 'DELIVERED':
      return 4;
    default:
      return -1;
  }
}

/** The order's progress as garments pegged along a clothesline. */
export function Clothesline({ status, holdFrom }: { status: string; holdFrom?: string | null }) {
  const { t } = useI18n();
  const effective = status === 'ON_HOLD' && holdFrom ? holdFrom : status;
  const current = phaseIndex(effective);
  const cancelled = status === 'CANCELLED';
  return (
    <div className={`line${cancelled ? ' line-cancelled' : ''}${status === 'ON_HOLD' ? ' line-hold' : ''}`}>
      <p className="line-status" aria-live="polite">{t(`status.${status}` as any)}</p>
      <ol className="line-pegs" aria-label={t(`status.${status}` as any)}>
        {PHASES.map((p, i) => {
          const state = cancelled ? 'todo' : i < current ? 'done' : i === current ? 'now' : 'todo';
          return (
            <li key={p} className={`peg peg-${state}`} aria-current={state === 'now' ? 'step' : undefined}>
              <svg viewBox="0 0 40 44" aria-hidden="true" className="garment">
                <rect x="17" y="0" width="6" height="10" rx="1.5" className="clip" />
                <path d="M8 10 L16 7 Q20 12 24 7 L32 10 L39 19 L33 24 L31 21 L31 42 L9 42 L9 21 L7 24 L1 19 Z" />
              </svg>
              <span>{t(`phase.${p}` as any)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export const statusTone = (s: string): 'neutral' | 'ok' | 'warn' | 'bad' | 'info' =>
  s === 'DELIVERED' ? 'ok' : s === 'CANCELLED' ? 'bad' : s === 'AWAITING_APPROVAL' || s === 'ON_HOLD' || s === 'INSPECTION_REQUIRED' ? 'warn' : 'info';
export const payTone = (s: string): 'neutral' | 'ok' | 'warn' | 'bad' | 'info' =>
  s === 'PAID' || s === 'SUCCESSFUL' ? 'ok' : s === 'FAILED' ? 'bad' : s === 'PENDING' || s === 'PARTIALLY_PAID' ? 'warn' : 'neutral';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    return () => d?.close?.();
  }, []);
  return (
    <dialog ref={ref} className="sheet" onCancel={(e) => { e.preventDefault(); onClose(); }} aria-labelledby="sheet-title">
      <div className="sheet-head">
        <h2 id="sheet-title">{title}</h2>
        <button type="button" className="btn btn-quiet" onClick={onClose}>{t('common.close')}</button>
      </div>
      <div className="sheet-body">{children}</div>
    </dialog>
  );
}
