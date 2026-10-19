import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useI18n } from '../../i18n';
import type { OrderSummary, Paged } from '../../types';
import { Clothesline, ErrorBox, Loading, useLoad } from '../../components/ui';

export function SupportLinks() {
  const { t } = useI18n();
  const { config } = useAuth();
  if (!config) return null;
  return (
    <div className="support">
      <a className="btn btn-secondary" href={`https://wa.me/${config.support.whatsapp}`} target="_blank" rel="noopener noreferrer">{t('home.whatsapp')}</a>
      <a className="btn btn-secondary" href={`tel:${config.support.phone}`}>{t('home.call')}</a>
    </div>
  );
}

export function HomePage() {
  const { t, slotLabel, money } = useI18n();
  const { user } = useAuth();
  const active = useLoad<Paged<OrderSummary>>('/bookings?scope=active&pageSize=3');
  const sub = useLoad<{ active: any | null }>('/subscriptions/current');
  const first = user?.fullName.split(' ')[0] ?? '';
  const orders = active.data?.items ?? [];

  return (
    <div className="stack-lg">
      <section className="hero">
        <h1>{t('home.greeting', { name: first })}</h1>
        <Link to="/book" className="btn btn-primary btn-hero">
          {t('home.book')}
          <small>{t('home.bookHint')}</small>
        </Link>
      </section>

      <section aria-labelledby="active-h">
        <h2 id="active-h">{t('home.active')}</h2>
        {active.loading && !active.data ? <Loading /> : <ErrorBox error={active.error} onRetry={active.reload} />}
        {active.data && orders.length === 0 && <p className="muted">{t('home.noActive')}</p>}
        {orders.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="order-card">
            {o.status === 'AWAITING_APPROVAL' && <p className="attention">{t('home.approvalNeeded')}</p>}
            <div className="order-card-head">
              <strong>{o.reference}</strong>
              <span>{money(o.total)}</span>
            </div>
            <Clothesline status={o.status} />
            {o.pickupSlot && <p className="muted small">{t('order.pickup')}: {slotLabel(o.pickupSlot.startsAt, o.pickupSlot.endsAt)}</p>}
          </Link>
        ))}
      </section>

      <section className="shortcuts">
        <Link to="/wardrobe" className="shortcut">
          <strong>{t('home.wardrobe')}</strong>
          <span>{t('home.wardrobeHint')}</span>
        </Link>
        <Link to="/subscription" className="shortcut">
          <strong>{t('home.subscription')}</strong>
          <span>
            {sub.data?.active
              ? t('home.subscriptionActive', { remaining: `${sub.data.active.unitsRemaining} ${t(`unit.${sub.data.active.plan.allowanceUnit}` as any)}` })
              : t('home.subscriptionHint')}
          </span>
        </Link>
      </section>

      <section aria-labelledby="help-h">
        <h2 id="help-h">{t('home.help')}</h2>
        <SupportLinks />
      </section>
    </div>
  );
}
