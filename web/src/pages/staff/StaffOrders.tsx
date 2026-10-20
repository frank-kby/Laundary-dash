import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog } from '../../catalog';
import { useI18n } from '../../i18n';
import type { OrderDetail, OrderSummary, Paged } from '../../types';
import { Badge, Button, Checkbox, ColorDot, ErrorBox, Loading, Notice, payTone, SelectField, statusTone, TextArea, TextField, useLoad } from '../../components/ui';
import { PriceBreakdown } from '../customer/Book';

const STATUSES = ['PENDING_CONFIRMATION', 'CONFIRMED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'INSPECTION_REQUIRED', 'AWAITING_APPROVAL', 'PROCESSING', 'READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'ON_HOLD'];
const ISSUE_TYPES = ['FAILED_PICKUP', 'FAILED_DELIVERY', 'GARMENT_DISPUTE', 'DELAY', 'PAYMENT_UNCERTAIN', 'DAMAGE', 'OTHER'];

export function StaffOrdersPage() {
  const { t, money, slotLabel } = useI18n();
  const [f, setF] = useState({ status: '', q: '', openIssues: false, page: 1 });
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ page: String(f.page), pageSize: '25', ...(f.status ? { status: f.status } : {}), ...(f.q ? { q: f.q } : {}), ...(f.openIssues ? { openIssues: 'true' } : {}) });
  const list = useLoad<Paged<OrderSummary>>(`/admin/orders?${qs}`);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <div className="stack">
      <h1>{t('staff.orders')}</h1>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); setF({ ...f, q, page: 1 }); }}>
        <TextField label={t('staff.search')} value={q} onChange={(e) => setQ(e.target.value)} type="search" />
        <SelectField label={t('staff.allStatuses')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}>
          <option value="">{t('staff.allStatuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}` as any)}</option>)}
        </SelectField>
        <Checkbox label={t('staff.openIssues')} checked={f.openIssues} onChange={(v) => setF({ ...f, openIssues: v, page: 1 })} />
        <Button type="submit" variant="secondary">{t('staff.apply')}</Button>
      </form>
      {list.loading && !list.data ? <Loading /> : <ErrorBox error={list.error} onRetry={list.reload} />}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Ref</th><th>{t('staff.customer')}</th><th>{t('book.area')}</th><th>{t('order.pickup')}</th><th>Status</th><th>{t('order.payments')}</th><th className="num">{t('order.total')}</th></tr></thead>
          <tbody>
            {list.data?.items.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/staff/orders/${o.id}`}>{o.reference}</Link></td>
                <td>{o.customerName}<span className="block muted small">{o.customerPhone}</span></td>
                <td>{o.areaName}</td>
                <td className="small">{o.pickupSlot && slotLabel(o.pickupSlot.startsAt, o.pickupSlot.endsAt)}</td>
                <td><Badge tone={statusTone(o.status)}>{t(`status.${o.status}` as any)}</Badge></td>
                <td><Badge tone={payTone(o.paymentStatus)}>{t(`pay.${o.paymentStatus}` as any)}</Badge></td>
                <td className="num">{money(o.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data && list.data.items.length === 0 && <Notice>{t('bookings.empty')}</Notice>}
      <div className="pager">
        <Button variant="quiet" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>‹</Button>
        <span>{f.page} / {pages}</span>
        <Button variant="quiet" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>›</Button>
      </div>
    </div>
  );
}

function useAction(setOrder: (o: OrderDetail) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (path: string, body: object, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ order: OrderDetail }>(path, body);
      if (r?.order) setOrder(r.order);
      after?.();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function StatusPanel({ o, set }: { o: OrderDetail; set: (o: OrderDetail) => void }) {
  const { t } = useI18n();
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const a = useAction(set);
  const options = (o.allowedNextStatuses ?? []).filter((s) => s !== 'AWAITING_APPROVAL');
  if (!options.length) return null;
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); a.run(`/admin/orders/${o.id}/status`, { status: to, note }, () => { setTo(''); setNote(''); }); }}>
      <h2>{t('staff.moveTo')}</h2>
      <div className="row-2">
        <SelectField label={t('staff.moveTo')} value={to} onChange={(e) => setTo(e.target.value)} required>
          <option value="">—</option>
          {options.map((s) => <option key={s} value={s}>{t(`status.${s}` as any)}</option>)}
        </SelectField>
        <TextField label={t('staff.statusNote')} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <ErrorBox error={a.error} />
      <Button type="submit" busy={a.busy} disabled={!to}>{t('staff.apply')}</Button>
    </form>
  );
}

function InspectionPanel({ o, set }: { o: OrderDetail; set: (o: OrderDetail) => void }) {
  const { t } = useI18n();
  const { catalog } = useCatalog();
  const [rows, setRows] = useState(() => Object.fromEntries(o.items.map((i) => [i.id, { qty: String(i.receivedQuantity ?? (i.pricingUnit === 'ITEM' ? i.declaredQuantity : '')), kg: String(i.measuredWeightKg ?? ''), cond: i.conditionNotes }])));
  const [extra, setExtra] = useState({ description: '', amount: '' });
  const [added, setAdded] = useState({ name: '', categoryId: '', serviceId: '', quantity: '' });
  const [reason, setReason] = useState('');
  const a = useAction(set);
  if (!['PICKED_UP', 'RECEIVED', 'INSPECTION_REQUIRED', 'AWAITING_APPROVAL'].includes(o.status)) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    a.run(`/admin/orders/${o.id}/inspection`, {
      items: o.items.map((i) => ({
        id: i.id,
        ...(i.pricingUnit === 'ITEM' ? { receivedQuantity: Number(rows[i.id].qty || 0) } : { measuredWeightKg: Number(rows[i.id].kg || 0) }),
        conditionNotes: rows[i.id].cond,
      })),
      addItems: added.name && added.categoryId && added.serviceId && Number(added.quantity) > 0 ? [{ ...added, quantity: Number(added.quantity) }] : [],
      adjustments: extra.description && extra.amount ? [{ description: extra.description, amount: Number(extra.amount) }] : [],
      reason: reason || 'Inspection',
    });
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>{t('staff.inspection')}</h2>
      <p className="hint">{t('staff.inspectionHint')}</p>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{t('order.items')}</th><th>{t('order.declared', { n: '' })}</th><th>{t('staff.receivedQty')} / {t('staff.weightKg')}</th><th>{t('staff.condition')}</th></tr></thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.id}>
                <td><span className="item-line">{(i.colorHex || i.color) && <ColorDot hex={i.colorHex} name={i.color} />}{i.name}</span><span className="block muted small">{i.color && `${i.color}, `}{i.serviceName}{i.careNotes && `: ${i.careNotes}`}</span></td>
                <td>{i.declaredQuantity}{i.pricingUnit === 'KG' ? ' kg' : ''}</td>
                <td>
                  {i.pricingUnit === 'ITEM'
                    ? <input aria-label={`${t('staff.receivedQty')} ${i.name}`} type="number" min={0} value={rows[i.id].qty} onChange={(e) => setRows({ ...rows, [i.id]: { ...rows[i.id], qty: e.target.value } })} />
                    : <input aria-label={`${t('staff.weightKg')} ${i.name}`} type="number" min={0} step={0.1} value={rows[i.id].kg} onChange={(e) => setRows({ ...rows, [i.id]: { ...rows[i.id], kg: e.target.value } })} required />}
                </td>
                <td><input aria-label={`${t('staff.condition')} ${i.name}`} value={rows[i.id].cond} onChange={(e) => setRows({ ...rows, [i.id]: { ...rows[i.id], cond: e.target.value } })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>{t('staff.addLine')}</summary>
        <div className="row-2">
          <TextField label={t('wardrobe.name')} value={added.name} onChange={(e) => setAdded({ ...added, name: e.target.value })} />
          <SelectField label={t('wardrobe.category')} value={added.categoryId} onChange={(e) => setAdded({ ...added, categoryId: e.target.value })}>
            <option value="">—</option>
            {catalog?.categories.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
          </SelectField>
          <SelectField label={t('book.service')} value={added.serviceId} onChange={(e) => setAdded({ ...added, serviceId: e.target.value })}>
            <option value="">—</option>
            {catalog?.services.map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}
          </SelectField>
          <TextField label={t('wardrobe.quantity')} type="number" value={added.quantity} onChange={(e) => setAdded({ ...added, quantity: e.target.value })} />
        </div>
      </details>
      <div className="row-2">
        <TextField label={`${t('staff.extraCharge')}: ${t('staff.extraDesc')}`} optional value={extra.description} onChange={(e) => setExtra({ ...extra, description: e.target.value })} />
        <TextField label={t('staff.amount')} optional type="number" value={extra.amount} onChange={(e) => setExtra({ ...extra, amount: e.target.value })} />
      </div>
      <TextField label={t('staff.reason')} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Inspection" />
      <ErrorBox error={a.error} />
      <Button type="submit" busy={a.busy}>{t('staff.saveInspection')}</Button>
    </form>
  );
}

function RevisionPanel({ o, set }: { o: OrderDetail; set: (o: OrderDetail) => void }) {
  const { t, money } = useI18n();
  const [d, setD] = useState({ decision: 'APPROVE', channel: 'PHONE', note: '' });
  const a = useAction(set);
  if (!o.pendingRevision) return null;
  const r = o.pendingRevision;
  return (
    <form className="panel panel-attention" onSubmit={(e) => { e.preventDefault(); a.run(`/admin/orders/${o.id}/price-revisions/${r.id}/decision`, d); }}>
      <h2>{t('staff.recordDecision')}</h2>
      <p>{money(r.previousTotal)} → <strong>{money(r.proposedTotal)}</strong> · {r.reason}</p>
      <div className="row-2">
        <SelectField label={t('staff.recordDecision')} value={d.decision} onChange={(e) => setD({ ...d, decision: e.target.value })}>
          <option value="APPROVE">{t('common.yes')}</option>
          <option value="REJECT">{t('common.no')}</option>
        </SelectField>
        <SelectField label={t('staff.channel')} value={d.channel} onChange={(e) => setD({ ...d, channel: e.target.value })}>
          <option value="PHONE">Phone</option>
          <option value="WHATSAPP">WhatsApp</option>
          <option value="IN_PERSON">In person</option>
        </SelectField>
      </div>
      <TextField label={t('rider.note')} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} required minLength={2} />
      <ErrorBox error={a.error} />
      <Button type="submit" busy={a.busy}>{t('common.save')}</Button>
    </form>
  );
}

function ExtraChargePanel({ o, set }: { o: OrderDetail; set: (o: OrderDetail) => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ description: '', amount: '', reason: '' });
  const a = useAction(set);
  if (!['RECEIVED', 'INSPECTION_REQUIRED'].includes(o.status)) return null;
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); a.run(`/admin/orders/${o.id}/price-revisions`, { adjustments: [{ description: f.description, amount: Number(f.amount) }], reason: f.reason }, () => setF({ description: '', amount: '', reason: '' })); }}>
      <h2>{t('staff.revision')}</h2>
      <div className="row-2">
        <TextField label={t('staff.extraDesc')} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required />
        <TextField label={t('staff.amount')} type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
      </div>
      <TextField label={t('staff.reason')} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required />
      <ErrorBox error={a.error} />
      <Button type="submit" variant="secondary" busy={a.busy}>{t('staff.revision')}</Button>
    </form>
  );
}

function RiderPanel({ o, set }: { o: OrderDetail; set: (o: OrderDetail) => void }) {
  const { t } = useI18n();
  const riders = useLoad<{ items: { id: string; name: string; openTasks: number }[] }>('/admin/riders');
  const [rider, setRider] = useState('');
  const [note, setNote] = useState('');
  const a = useAction(set);
  const type = ['CONFIRMED', 'PICKUP_SCHEDULED'].includes(o.status) ? 'PICKUP' : o.status === 'READY_FOR_DELIVERY' && o.deliveryPreference === 'DELIVER_TO_ADDRESS' ? 'DELIVERY' : null;
  if (!type && o.riderTasks.length === 0) return null;
  return (
    <section className="panel">
      <h2>{t('staff.assign')}</h2>
      {o.riderTasks.length > 0 && (
        <ul className="list small">
          {o.riderTasks.map((r) => <li key={r.id} className="list-row static"><span>{t(`rider.${r.type}` as any)} · {r.riderName}</span><span>{t(`rider.status.${r.status}` as any)}{r.failureReason && ` (${r.failureReason})`}</span></li>)}
        </ul>
      )}
      {type && (
        <form onSubmit={(e) => { e.preventDefault(); a.run(`/admin/orders/${o.id}/rider-tasks`, { type, riderId: rider, instructions: note }); }} className="stack">
          <div className="row-2">
            <SelectField label={`${t('staff.rider')} (${t(`rider.${type}` as any)})`} value={rider} onChange={(e) => setRider(e.target.value)} required>
              <option value="">—</option>
              {riders.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.openTasks})</option>)}
            </SelectField>
            <TextField label={t('rider.note')} optional value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <ErrorBox error={a.error} />
          <Button type="submit" variant="secondary" busy={a.busy} disabled={!rider}>{t('staff.assign')}</Button>
        </form>
      )}
    </section>
  );
}

function IssuesPanel({ o, set }: { o: OrderDetail; set: (o: OrderDetail) => void }) {
  const { t, dateTime } = useI18n();
  const [f, setF] = useState({ type: 'DELAY', description: '', putOnHold: false, notifyCustomer: false });
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const a = useAction(set);
  return (
    <section className="panel">
      <h2>{t('staff.issues')}</h2>
      <ul className="list small">
        {o.issues.map((i) => (
          <li key={i.id} className="list-row static issue">
            <span><Badge tone={i.status === 'OPEN' ? 'warn' : 'neutral'}>{i.type}</Badge> {i.description} <span className="muted">{dateTime(i.createdAt)}</span>{i.resolution && <span className="block">✓ {i.resolution}</span>}</span>
            {i.status === 'OPEN' && (
              <span className="inline-form">
                <input aria-label={t('staff.resolution')} placeholder={t('staff.resolution')} value={resolution[i.id] ?? ''} onChange={(e) => setResolution({ ...resolution, [i.id]: e.target.value })} />
                <Button variant="quiet" busy={a.busy} onClick={() => a.run(`/admin/issues/${i.id}/resolve`, { resolution: resolution[i.id] ?? '' })}>{t('staff.resolve')}</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); a.run(`/admin/orders/${o.id}/issues`, f, () => setF({ ...f, description: '' })); }}>
        <div className="row-2">
          <SelectField label={t('staff.newIssue')} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {ISSUE_TYPES.map((x) => <option key={x}>{x}</option>)}
          </SelectField>
          <TextField label={t('staff.extraDesc')} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required minLength={3} />
        </div>
        <Checkbox label={t('staff.putOnHold')} checked={f.putOnHold} onChange={(v) => setF({ ...f, putOnHold: v })} />
        <Checkbox label={t('staff.showCustomer')} checked={f.notifyCustomer} onChange={(v) => setF({ ...f, notifyCustomer: v })} />
        <ErrorBox error={a.error} />
        <Button type="submit" variant="secondary" busy={a.busy}>{t('staff.newIssue')}</Button>
      </form>
    </section>
  );
}

function PaymentsPanel({ o, set, reload }: { o: OrderDetail; set: (o: OrderDetail) => void; reload: () => void }) {
  const { t, money } = useI18n();
  const { user } = useAuth();
  const [f, setF] = useState({ amount: '', method: 'CASH', reference: '', note: '' });
  const [refund, setRefund] = useState<{ id: string; amount: string; method: string; reason: string } | null>(null);
  const a = useAction(set);
  return (
    <section className="panel">
      <h2>{t('order.payments')} <Badge tone={payTone(o.paymentStatus)}>{t(`pay.${o.paymentStatus}` as any)}</Badge></h2>
      <p>{t('order.total')}: {money(o.balance.due)} · {t('order.paid')}: {money(o.balance.paid)} · {t('order.balance')}: <strong>{money(o.balance.balance)}</strong>{o.balance.pending > 0 && ` · ${t('pay.PENDING')}: ${money(o.balance.pending)}`}</p>
      <ul className="list small">
        {o.payments.map((p) => (
          <li key={p.id} className="list-row static">
            <span>{money(p.amount)} · {p.method}{p.manualReference && ` · ${p.manualReference}`}{p.refundedAmount > 0 && ` · −${money(p.refundedAmount)}`} {p.testMode && <Badge tone="warn">TEST</Badge>}</span>
            <span className="inline-form">
              <Badge tone={payTone(p.status)}>{t(`pay.${p.status}` as any)}</Badge>
              {p.status === 'PENDING' && p.provider && <Button variant="quiet" busy={a.busy} onClick={async () => { await post(`/admin/payments/${p.id}/check-status`, {}).catch(() => {}); reload(); }}>{t('staff.checkStatus')}</Button>}
              {user?.role === 'ADMIN' && ['SUCCESSFUL', 'PARTIALLY_REFUNDED'].includes(p.status) && <Button variant="quiet" onClick={() => setRefund({ id: p.id, amount: String(p.amount - p.refundedAmount), method: 'CASH', reason: '' })}>{t('staff.refund')}</Button>}
            </span>
          </li>
        ))}
      </ul>
      {refund && (
        <form className="stack inset" onSubmit={async (e) => { e.preventDefault(); if (await a.run(`/admin/payments/${refund.id}/refunds`, { ...refund, amount: Number(refund.amount) })) { setRefund(null); reload(); } }}>
          <div className="row-2">
            <TextField label={t('staff.amount')} type="number" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
            <SelectField label={t('staff.method')} value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>
              <option value="CASH">Cash</option><option value="MANUAL_MOBILE_MONEY">Mobile Money (manual)</option><option value="BANK_TRANSFER">Bank transfer</option>
            </SelectField>
          </div>
          <TextField label={t('staff.reason')} value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} required />
          <div className="actions"><Button type="button" variant="quiet" onClick={() => setRefund(null)}>{t('common.cancel')}</Button><Button type="submit" variant="danger" busy={a.busy}>{t('staff.refund')}</Button></div>
        </form>
      )}
      {o.status !== 'CANCELLED' && o.balance.balance > 0 && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); a.run(`/admin/orders/${o.id}/payments/manual`, { ...f, amount: Number(f.amount), reference: f.reference || undefined }, () => setF({ ...f, amount: '', reference: '', note: '' })); }}>
          <h3>{t('staff.manualPayment')}</h3>
          <div className="row-2">
            <TextField label={t('staff.amount')} type="number" min={1} max={o.balance.balance} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required />
            <SelectField label={t('staff.method')} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              <option value="CASH">Cash</option><option value="MANUAL_MOBILE_MONEY">Mobile Money to business number</option><option value="BANK_TRANSFER">Bank transfer</option>
            </SelectField>
          </div>
          {f.method !== 'CASH' && <TextField label={t('staff.reference')} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required />}
          <Button type="submit" variant="secondary" busy={a.busy}>{t('staff.manualPayment')}</Button>
        </form>
      )}
      <ErrorBox error={a.error} />
    </section>
  );
}

export function StaffOrderPage() {
  const { id } = useParams();
  const { t, slotLabel, dateTime } = useI18n();
  const d = useLoad<{ order: OrderDetail }>(`/admin/orders/${id}`);
  if (d.loading && !d.data) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} onRetry={d.reload} />;
  const o = d.data.order;
  const set = (order: OrderDetail) => d.setData({ order });
  return (
    <div className="stack">
      <p><Link to="/staff">‹ {t('staff.orders')}</Link></p>
      <div className="row-between">
        <h1>{o.reference}</h1>
        <Badge tone={statusTone(o.status)}>{t(`status.${o.status}` as any)}</Badge>
      </div>
      <div className="staff-grid">
        <div className="stack">
          <section className="panel">
            <h2>{t('staff.customer')}</h2>
            <p><strong>{o.customer?.name}</strong> · {o.customer?.phone && <a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a>} {o.customer?.email}</p>
            <p>{t('order.pickup')}: {slotLabel(o.pickupSlot.startsAt, o.pickupSlot.endsAt)} — {o.pickupAddress.serviceAreaName}, {o.pickupAddress.landmark} {o.pickupAddress.details}</p>
            <p>{t('order.return')}: {o.deliveryPreference === 'COLLECT_AT_SHOP' ? t('order.collectAtShop') : `${o.deliveryAddress?.serviceAreaName}, ${o.deliveryAddress?.landmark}`}</p>
            {o.customerNotes && <Notice>{o.customerNotes}</Notice>}
          </section>
          <RevisionPanel o={o} set={set} />
          <StatusPanel o={o} set={set} />
          <InspectionPanel key={`${o.id}-${o.status}`} o={o} set={set} />
          <ExtraChargePanel o={o} set={set} />
          <RiderPanel o={o} set={set} />
          <IssuesPanel o={o} set={set} />
        </div>
        <div className="stack">
          <section className="panel">
            <h2>{t('order.total')}</h2>
            <PriceBreakdown pricing={o.pricing} />
            {o.revisions.length > 0 && (
              <ul className="list small">{o.revisions.map((r) => <li key={r.id} className="list-row static"><span>{r.reason}: {r.previousTotal} → {r.proposedTotal}</span><span>{r.status}{r.decisionChannel && ` (${r.decisionChannel})`}</span></li>)}</ul>
            )}
          </section>
          <PaymentsPanel o={o} set={set} reload={d.reload} />
          <section className="panel">
            <h2>{t('order.history')}</h2>
            <ol className="timeline">
              {[...o.events].reverse().map((e) => (
                <li key={e.id}><time>{dateTime(e.createdAt)}</time><span>{e.type}{e.toStatus && `: ${e.fromStatus ?? '—'} → ${e.toStatus}`}</span><span className="muted small">{e.note} {e.actor && `· ${e.actor}`}</span></li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
