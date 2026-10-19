import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, patch, post } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useLocalName } from '../../catalog';
import { useI18n, type Lang } from '../../i18n';
import type { Address, Paged, Payment, Plan, User } from '../../types';
import { PageTitle } from '../../components/Layout';
import { Badge, Button, ErrorBox, Loading, Notice, payTone, SelectField, Sheet, TextField, useLoad } from '../../components/ui';
import { PayPanel } from './Orders';

function AddressForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { catalog } = useCatalog();
  const [f, setF] = useState({ label: '', serviceAreaId: '', landmark: '', street: '', details: '', contactPhone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/me/addresses', { ...f, contactPhone: f.contactPhone || null });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="stack" noValidate>
      <TextField label={t('account.addressLabel')} placeholder={t('account.addressLabelHint')} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required maxLength={40} />
      <SelectField label={t('book.area')} value={f.serviceAreaId} onChange={(e) => setF({ ...f, serviceAreaId: e.target.value })} required>
        <option value="">{t('book.chooseArea')}</option>
        {catalog?.areas.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.district})</option>)}
      </SelectField>
      <TextField label={t('book.landmark')} hint={t('book.landmarkHint')} value={f.landmark} onChange={(e) => setF({ ...f, landmark: e.target.value })} required />
      <TextField label={t('book.street')} optional value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} />
      <TextField label={t('book.details')} optional hint={t('book.detailsHint')} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
      <TextField label={t('book.contactPhone')} optional type="tel" value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} />
      <ErrorBox error={error} />
      <div className="actions">
        <Button type="button" variant="quiet" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" busy={busy}>{t('common.save')}</Button>
      </div>
    </form>
  );
}

export function AccountPage() {
  const { t, setLang, lang, dateTime, money } = useI18n();
  const { user, setUser, logout } = useAuth();
  const nav = useNavigate();
  const addresses = useLoad<{ items: Address[] }>('/me/addresses');
  const notes = useLoad<Paged<any> & { unread: number }>('/me/notifications?pageSize=10');
  const payments = useLoad<Paged<Payment>>('/payments?pageSize=10');
  const [adding, setAdding] = useState(false);
  const [profile, setProfile] = useState({ fullName: user?.fullName ?? '', email: user?.email ?? '', phone: user?.phone ?? '', currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const body: any = { fullName: profile.fullName };
      if ((profile.email || null) !== user?.email) body.email = profile.email || null;
      if ((profile.phone || null) !== user?.phone) body.phone = profile.phone || null;
      if (profile.newPassword) body.newPassword = profile.newPassword;
      if (body.email !== undefined || body.phone !== undefined || body.newPassword) body.currentPassword = profile.currentPassword;
      const r = await patch<{ user: User }>('/me', body);
      setUser(r.user);
      setProfile({ ...profile, email: r.user.email ?? '', phone: r.user.phone ?? '', currentPassword: '', newPassword: '' });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const changeLang = async (l: Lang) => {
    setLang(l);
    try {
      const r = await patch<{ user: User }>('/me', { preferredLanguage: l });
      setUser(r.user);
    } catch {
      /* local preference still applies */
    }
  };

  return (
    <div className="stack-lg">
      <PageTitle>{t('account.title')}</PageTitle>

      <section>
        <h2>{t('account.notifications')}</h2>
        {notes.data?.items.length === 0 && <p className="muted">{t('account.noNotifications')}</p>}
        <ul className="list small">
          {notes.data?.items.map((n) => (
            <li key={n.id} className={`list-row static${n.readAt ? '' : ' unread'}`}>
              <span><strong>{n.title}</strong> {n.body}</span>
              <time className="muted">{dateTime(n.createdAt)}</time>
            </li>
          ))}
        </ul>
        {!!notes.data?.unread && <Button variant="quiet" onClick={async () => { await post('/me/notifications/read-all'); notes.reload(); }}>{t('account.markRead')}</Button>}
      </section>

      <section>
        <h2>{t('account.language')}</h2>
        <div className="segmented">
          <button className={lang === 'en' ? 'on' : ''} aria-pressed={lang === 'en'} onClick={() => changeLang('en')}>English</button>
          <button className={lang === 'rw' ? 'on' : ''} aria-pressed={lang === 'rw'} onClick={() => changeLang('rw')}>Kinyarwanda</button>
        </div>
      </section>

      <section>
        <h2>{t('account.addresses')}</h2>
        {addresses.loading && !addresses.data && <Loading />}
        {addresses.data?.items.length === 0 && <p className="muted">{t('account.noAddresses')}</p>}
        <ul className="list">
          {addresses.data?.items.map((a) => (
            <li key={a.id} className="list-row static">
              <span><strong>{a.label}</strong> <span className="muted small">{a.serviceAreaName} · {a.landmark}</span></span>
              <button className="btn btn-quiet danger-text" onClick={async () => { await del(`/me/addresses/${a.id}`); addresses.reload(); }}>{t('common.delete')}</button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" onClick={() => setAdding(true)}>{t('account.addAddress')}</Button>
      </section>

      <section>
        <h2>{t('account.payments')}</h2>
        <ul className="list small">
          {payments.data?.items.map((p) => (
            <li key={p.id} className="list-row static">
              <span>{money(p.amount)} · {dateTime(p.createdAt)} {p.testMode && <Badge tone="warn">TEST</Badge>}</span>
              <Badge tone={payTone(p.status)}>{t(`pay.${p.status}` as any)}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>{t('account.security')}</h2>
        <form onSubmit={saveProfile} className="stack" noValidate>
          <TextField label={t('auth.fullName')} value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} autoComplete="name" />
          <TextField label={t('auth.email')} optional type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} autoComplete="email" />
          <TextField label={t('auth.phone')} optional type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} autoComplete="tel" />
          <TextField label={t('account.changePassword')} type="password" value={profile.newPassword} onChange={(e) => setProfile({ ...profile, newPassword: e.target.value })} autoComplete="new-password" />
          <TextField label={t('account.currentPassword')} hint={t('account.currentPasswordHint')} type="password" value={profile.currentPassword} onChange={(e) => setProfile({ ...profile, currentPassword: e.target.value })} autoComplete="current-password" />
          <ErrorBox error={error} />
          {saved && <Notice tone="ok">{t('common.saved')}</Notice>}
          <Button type="submit" busy={busy}>{t('common.save')}</Button>
        </form>
      </section>

      <section>
        <Button variant="secondary" className="btn-block" onClick={async () => { await logout(); nav('/login'); }}>{t('auth.signOut')}</Button>
        <p className="hint">{t('account.signOutHint')}</p>
      </section>

      {adding && <Sheet title={t('account.addAddress')} onClose={() => setAdding(false)}><AddressForm onCancel={() => setAdding(false)} onDone={() => { setAdding(false); addresses.reload(); }} /></Sheet>}
    </div>
  );
}

export function SubscriptionPage() {
  const { t, money, date, lang } = useI18n();
  const name = useLocalName();
  const plans = useLoad<{ items: Plan[] }>('/subscription-plans');
  const cur = useLoad<{ active: any; upcoming: any[]; usage: any[] }>('/subscriptions/current');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = cur.data?.upcoming.find((s) => s.status === 'PENDING_PAYMENT');
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      cur.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageTitle back={() => history.back()}>{t('sub.title')}</PageTitle>
      <p className="muted">{t('sub.intro')}</p>
      {(cur.loading && !cur.data) || (plans.loading && !plans.data) ? <Loading /> : null}
      <ErrorBox error={error || cur.error || plans.error} />

      {cur.data?.active && (
        <section className="plan plan-active">
          <h2>{t('sub.active')}: {lang === 'rw' ? cur.data.active.plan.nameRw : cur.data.active.plan.nameEn}</h2>
          <p>{t('sub.remaining', { units: cur.data.active.unitsRemaining, unit: t(`unit.${cur.data.active.plan.allowanceUnit}` as any), trips: cur.data.active.tripsRemaining, date: date(cur.data.active.endsAt) })}</p>
          {cur.data.usage.length > 0 && (
            <p className="small muted">{t('sub.usage')}: {cur.data.usage.map((u) => `${u.reference} (${u.unitsUsed})`).join(', ')}</p>
          )}
          {!pending && <Button variant="secondary" busy={busy} onClick={() => act(() => post(`/subscriptions/${cur.data!.active.id}/renew`))}>{t('sub.renew')}</Button>}
        </section>
      )}
      {cur.data?.upcoming.filter((s) => s.status === 'ACTIVE').map((s) => (
        <Notice key={s.id}>{t('sub.upcoming')}: {lang === 'rw' ? s.plan.nameRw : s.plan.nameEn} ({date(s.startsAt)} – {date(s.endsAt)})</Notice>
      ))}

      {pending && (
        <section className="plan plan-pending">
          <h2>{t('sub.pending')}: {lang === 'rw' ? pending.plan.nameRw : pending.plan.nameEn} · {money(pending.plan.price)}</h2>
          <p>{t('sub.pendingBody')}</p>
          <PayPanel target={{ subscriptionId: pending.id }} amount={pending.plan.price} onChanged={cur.reload} />
          <Button variant="quiet" busy={busy} onClick={() => act(() => post(`/subscriptions/${pending.id}/cancel-pending`))}>{t('sub.cancelPending')}</Button>
        </section>
      )}

      {!pending && (
        <ul className="plans">
          {plans.data?.items.map((p) => (
            <li key={p.id} className="plan">
              <h2>{name(p)}</h2>
              <p className="plan-price">{money(p.price)}</p>
              <p>{lang === 'rw' ? p.descriptionRw : p.descriptionEn}</p>
              <ul className="small">
                <li>{p.allowanceUnit === 'KG' ? t('sub.allowanceKg', { qty: p.allowanceQuantity }) : t('sub.allowanceItem', { qty: p.allowanceQuantity })}</li>
                <li>{t('sub.trips', { n: p.freeTrips })}</li>
                {p.overageDiscountPercent > 0 && <li>{t('sub.overage', { p: p.overageDiscountPercent })}</li>}
                <li>{t('sub.validity', { days: p.validityDays })}</li>
              </ul>
              <Button busy={busy} onClick={() => act(() => post('/subscriptions', { planId: p.id }))}>{t('sub.choose')}</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
