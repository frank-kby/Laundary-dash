import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, newKey, post } from '../../api';
import { useAuth } from '../../auth';
import { useI18n } from '../../i18n';
import type { OrderDetail, OrderSummary, Paged, Payment, Slot } from '../../types';
import { PageTitle } from '../../components/Layout';
import { Badge, Button, Clothesline, ErrorBox, Loading, Notice, payTone, Sheet, statusTone, TextField, useLoad } from '../../components/ui';
import { PriceBreakdown, SlotPicker } from './Book';

const CANCELLABLE = ['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED'];

export function BookingsPage() {
  const { t, money, date } = useI18n();
  const [scope, setScope] = useState<'active' | 'past'>('active');
  const [pageSize, setPageSize] = useState(20);
  const list = useLoad<Paged<OrderSummary>>(`/bookings?scope=${scope}&pageSize=${pageSize}`);
  return (
    <div className="stack">
      <PageTitle>{t('bookings.title')}</PageTitle>
      <div className="segmented" role="tablist">
        {(['active', 'past'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={scope === s} className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>{t(`bookings.${s}`)}</button>
        ))}
      </div>
      {list.loading && !list.data ? <Loading /> : <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data?.items.length === 0 && (
        <Notice>
          {t('bookings.empty')} <Link to="/book">{t('home.book')}</Link>
        </Notice>
      )}
      <ul className="list">
        {list.data?.items.map((o) => (
          <li key={o.id}>
            <Link to={`/orders/${o.id}`} className="list-row">
              <span>
                <strong>{o.reference}</strong>
                <span className="muted small"> {date(o.createdAt)} · {t('bookings.items', { n: o.itemCount })}</span>
              </span>
              <span className="list-row-end">
                <Badge tone={statusTone(o.status)}>{t(`status.${o.status}` as any)}</Badge>
                <span className="small">{money(o.total)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {list.data && list.data.total > list.data.items.length && <Button variant="secondary" onClick={() => setPageSize((n) => n + 20)}>{t('common.loadMore')}</Button>}
    </div>
  );
}

/** Mobile Money payment panel. Shows TEST MODE clearly; never asks for a PIN. */
export function PayPanel({ target, amount, onChanged }: { target: { orderId?: string; subscriptionId?: string }; amount: number; onChanged: () => void }) {
  const { t, money } = useI18n();
  const { config, user } = useAuth();
  const momo = config?.features.mobileMoney;
  const [msisdn, setMsisdn] = useState(user?.phone ?? '');
  const [payment, setPayment] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newKey());
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const poll = (id: string, tries = 0) => {
    timer.current = window.setTimeout(async () => {
      try {
        const r = await get<{ payment: Payment }>(`/payments/${id}`);
        setPayment(r.payment);
        if (r.payment.status !== 'PENDING') onChanged();
        else if (tries < 20) poll(id, tries + 1);
      } catch {
        /* keep last known state; user can check manually */
      }
    }, 5000);
  };

  if (!momo) return <Notice>{t('order.momoOff')}</Notice>;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ payment: Payment }>('/payments', { ...target, msisdn }, key.current);
      setPayment(r.payment);
      key.current = newKey();
      if (r.payment.status === 'PENDING') poll(r.payment.id);
      else onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    if (!payment) return;
    setBusy(true);
    try {
      const r = await get<{ payment: Payment }>(`/payments/${payment.id}`);
      setPayment(r.payment);
      if (r.payment.status !== 'PENDING') onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const simulate = async (outcome: 'SUCCESSFUL' | 'FAILED') => {
    if (!payment) return;
    setBusy(true);
    try {
      const r = await post<{ payment: Payment }>(`/payments/${payment.id}/simulate`, { outcome });
      setPayment(r.payment);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pay">
      {momo.testMode && <Notice tone="test">{t('common.testMode')}</Notice>}
      {payment?.status === 'PENDING' ? (
        <>
          <Notice tone="warn">{t('order.payPending')}</Notice>
          <p className="muted small" aria-live="polite">{t('order.payWaiting')} {payment.payerMsisdnMasked}</p>
          <Button variant="secondary" busy={busy} onClick={check}>{t('order.payCheck')}</Button>
          {momo.provider === 'simulator' && (
            <div className="actions">
              <Button variant="secondary" onClick={() => simulate('SUCCESSFUL')}>{t('order.simSuccess')}</Button>
              <Button variant="quiet" onClick={() => simulate('FAILED')}>{t('order.simFail')}</Button>
            </div>
          )}
        </>
      ) : (
        <>
          {payment && <p><Badge tone={payTone(payment.status)}>{t(`pay.${payment.status}` as any)}</Badge></p>}
          <TextField label={t('order.momoNumber')} type="tel" inputMode="tel" autoComplete="tel" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} />
          <Button busy={busy} onClick={start} disabled={amount <= 0}>{t('order.payNow')} · {money(amount)}</Button>
        </>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

export function OrderPage() {
  const { id } = useParams();
  const { t, money, slotLabel, dateTime } = useI18n();
  const order = useLoad<{ order: OrderDetail }>(`/orders/${id}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rescheduling, setRescheduling] = useState(false);

  if (order.loading && !order.data) return <Loading />;
  if (!order.data) return <ErrorBox error={order.error} onRetry={order.reload} />;
  const o = order.data.order;
  const set = (d: { order: OrderDetail }) => order.setData(d);

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r?.order) set(r);
      else order.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const rev = o.pendingRevision;
  return (
    <div className="stack">
      <PageTitle back={() => history.back()}>{t('order.title', { ref: o.reference })}</PageTitle>
      <Clothesline status={o.status} holdFrom={o.holdFromStatus} />

      {rev && o.status === 'AWAITING_APPROVAL' && (
        <section className="approval" aria-labelledby="appr-h">
          <h2 id="appr-h">{t('order.approvalTitle')}</h2>
          <p>{t('order.approvalBody', { new: money(rev.proposedTotal), old: money(rev.previousTotal), reason: rev.reason })}</p>
          <PriceBreakdown pricing={rev.pricing} />
          <div className="actions">
            <Button busy={busy} onClick={() => act(() => post(`/orders/${o.id}/price-approval`, { revisionId: rev.id, decision: 'APPROVE' }))}>{t('order.approve', { amount: money(rev.proposedTotal) })}</Button>
            <Button variant="secondary" busy={busy} onClick={() => confirm(t('order.rejectConfirm')) && act(() => post(`/orders/${o.id}/price-approval`, { revisionId: rev.id, decision: 'REJECT' }))}>{t('order.reject')}</Button>
          </div>
        </section>
      )}

      <ErrorBox error={error} />

      <section className="facts">
        <div>
          <h3>{t('order.pickup')}</h3>
          <p>{slotLabel(o.pickupSlot.startsAt, o.pickupSlot.endsAt)}</p>
          <p className="muted small">{o.pickupAddress.serviceAreaName} · {o.pickupAddress.landmark}</p>
        </div>
        <div>
          <h3>{t('order.return')}</h3>
          {o.deliveryPreference === 'COLLECT_AT_SHOP' ? <p>{t('order.collectAtShop')}</p> : <p className="muted small">{o.deliveryAddress?.serviceAreaName} · {o.deliveryAddress?.landmark}</p>}
        </div>
      </section>

      {CANCELLABLE.includes(o.status) && (
        <div className="actions">
          <Button variant="secondary" onClick={() => setRescheduling(true)}>{t('order.reschedule')}</Button>
          <Button variant="quiet" className="danger-text" busy={busy} onClick={() => confirm(t('order.cancelConfirm')) && act(() => post(`/bookings/${o.bookingId}/cancel`, {}))}>{t('order.cancel')}</Button>
        </div>
      )}

      <section>
        <h2>{t('order.items')}</h2>
        <ul className="list">
          {o.items.map((i) => (
            <li key={i.id} className="list-row static">
              <span>
                <strong>{i.name}</strong> <span className="muted small">{i.serviceName}</span>
                <span className="small block">
                  {i.pricingUnit === 'KG'
                    ? i.measuredWeightKg != null ? t('order.weighed', { kg: i.measuredWeightKg }) : `${t('order.declared', { n: i.declaredQuantity })} kg`
                    : i.receivedQuantity != null ? t('order.received', { n: i.receivedQuantity }) : t('order.declared', { n: i.declaredQuantity })}
                  {i.conditionNotes && ` · ${i.conditionNotes}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>{t('order.total')}</h2>
        <PriceBreakdown pricing={o.pricing} />
        <p className="row-between">
          <span>{t('order.paid')}: {money(o.balance.paid)}</span>
          <Badge tone={payTone(o.paymentStatus)}>{t(`pay.${o.paymentStatus}` as any)}</Badge>
        </p>
        {o.status !== 'CANCELLED' && o.status !== 'AWAITING_APPROVAL' && o.balance.balance > 0 && (
          <>
            <h3>{t('order.payMomo')} · {t('order.balance')}: {money(o.balance.balance)}</h3>
            <PayPanel target={{ orderId: o.id }} amount={o.balance.balance} onChanged={order.reload} />
            <p className="hint">{t('order.payCash')}</p>
          </>
        )}
        {o.payments.length > 0 && (
          <ul className="list small">
            {o.payments.map((p) => (
              <li key={p.id} className="list-row static">
                <span>{money(p.amount)} · {p.method.replaceAll('_', ' ').toLowerCase()} {p.testMode && <Badge tone="warn">TEST</Badge>}</span>
                <Badge tone={payTone(p.status)}>{t(`pay.${p.status}` as any)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>{t('order.history')}</h2>
        <ol className="timeline">
          {[...o.events].reverse().map((e) => (
            <li key={e.id}>
              <time dateTime={e.createdAt}>{dateTime(e.createdAt)}</time>
              <span>{e.toStatus ? t(`status.${e.toStatus}` as any) : e.note}</span>
              {e.toStatus && e.note && <span className="muted small">{e.note}</span>}
            </li>
          ))}
        </ol>
      </section>

      {rescheduling && <Reschedule order={o} onClose={() => setRescheduling(false)} onDone={(d) => { set(d); setRescheduling(false); }} />}
    </div>
  );
}

function Reschedule({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: (d: { order: OrderDetail }) => void }) {
  const { t } = useI18n();
  const slots = useLoad<{ items: Slot[] }>('/pickup-slots?days=7');
  const [slot, setSlot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Sheet title={t('order.reschedule')} onClose={onClose}>
      {slots.data ? <SlotPicker value={slot} onChange={setSlot} slots={slots.data.items.filter((s) => s.id !== order.pickupSlot.id)} /> : <Loading />}
      <ErrorBox error={error || slots.error} />
      <Button
        className="btn-block"
        disabled={!slot}
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onDone(await post(`/bookings/${order.bookingId}/reschedule`, { pickupSlotId: slot }));
          } catch (e) {
            setError(e);
            slots.reload();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('order.rescheduleSave')}
      </Button>
    </Sheet>
  );
}
