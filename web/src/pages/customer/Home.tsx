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
      <a className="btn btn-whatsapp" href={`https://wa.me/${config.support.whatsapp}`} target="_blank" rel="noopener noreferrer">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z" /><path d="M9 9.5c.3 2 2.3 4.3 5 5l1.2-1.2 2 1-.5 1.4c-3.7.6-8.4-3.8-8-7.6l1.3-.6 1 2z" /></svg>
        {t('home.whatsapp')}
      </a>
      <a className="btn btn-secondary" href={`tel:${config.support.phone}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>
        {t('home.call')}
      </a>
    </div>
  );
}

/** Soap bubbles: positions, sizes and timings are fixed so the motion feels calm, not random. */
const BUBBLES = [
  { l: '8%', s: 18, d: '12s', delay: '0s', x: '10px' },
  { l: '22%', s: 30, d: '15s', delay: '-4s', x: '-14px' },
  { l: '38%', s: 12, d: '10s', delay: '-7s', x: '8px' },
  { l: '55%', s: 24, d: '13s', delay: '-2s', x: '16px' },
  { l: '70%', s: 14, d: '11s', delay: '-9s', x: '-10px' },
  { l: '84%', s: 34, d: '16s', delay: '-6s', x: '12px' },
  { l: '46%', s: 20, d: '14s', delay: '-11s', x: '-18px' },
];

function BookHero() {
  const { t } = useI18n();
  return (
    <Link to="/book" className="hero-card">
      <div className="bubbles" aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <span key={i} style={{ left: b.l, width: b.s, height: b.s, ['--d' as string]: b.d, ['--delay' as string]: b.delay, ['--x' as string]: b.x }} />
        ))}
      </div>
      <svg className="hero-line" viewBox="0 0 168 92" aria-hidden="true">
        <path d="M0 10 Q84 34 168 10" fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.5" />
        <g className="g">
          <rect x="38" y="15" width="4" height="9" rx="1" fill="#fff" />
          <path d="M28 22 L36 19 Q40 24 44 19 L52 22 L58 31 L53 35 L51 32 L51 60 L33 60 L33 32 L31 35 L26 31 Z" fill="#f5c443" />
        </g>
        <g className="g">
          <rect x="86" y="21" width="4" height="9" rx="1" fill="#fff" />
          <path d="M80 28 L86 28 Q88 32 90 28 L96 28 L98 42 L108 76 L68 76 L78 42 Z" fill="#9ccbf3" />
        </g>
        <g className="g">
          <rect x="133" y="15" width="4" height="9" rx="1" fill="#fff" />
          <path d="M122 22 L148 22 L150 66 L139 66 L135 38 L131 66 L120 66 Z" fill="#ffffff" opacity=".9" />
        </g>
      </svg>
      <h2>{t('home.book')}</h2>
      <p>{t('home.bookHint')}</p>
      <span className="hero-cta">
        {t('home.bookCta')}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </span>
    </Link>
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
      <section className="greeting">
        <h1>{t('home.greeting', { name: first })}</h1>
        <p>{t('home.subtitle')}</p>
      </section>

      <BookHero />

      <section aria-labelledby="active-h">
        <div className="section-head">
          <h2 id="active-h">{t('home.active')}</h2>
          {orders.length > 0 && <Link to="/bookings" className="small">{t('nav.bookings')}</Link>}
        </div>
        {active.loading && !active.data ? <Loading rows={1} block /> : <ErrorBox error={active.error} onRetry={active.reload} />}
        {active.data && orders.length === 0 && (
          <div className="empty-card">
            <svg width="44" height="44" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#eaf2fb" /><path d="M15 20 L21 17.5 Q24 21 27 17.5 L33 20 L37 26 L33.5 28.5 L32 26.5 L32 36 L16 36 L16 26.5 L14.5 28.5 L11 26 Z" fill="#9ccbf3" stroke="#1f5fa8" strokeWidth="1.5" strokeLinejoin="round" /></svg>
            <span>{t('home.noActive')}</span>
          </div>
        )}
        {orders.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="order-card">
            {o.status === 'AWAITING_APPROVAL' && (
              <p className="attention">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>
                {t('home.approvalNeeded')}
              </p>
            )}
            <div className="order-card-head">
              <span>{o.reference}</span>
              <span>{money(o.total)}</span>
            </div>
            <Clothesline status={o.status} />
            {o.pickupSlot && <p className="muted small" style={{ marginTop: '.4rem' }}>{t('order.pickup')}: {slotLabel(o.pickupSlot.startsAt, o.pickupSlot.endsAt)}</p>}
          </Link>
        ))}
      </section>

      <section className="shortcuts">
        <Link to="/wardrobe" className="shortcut shortcut-aqua">
          <span className="ico">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5a2 2 0 1 1 2 2c-1 0-2 .7-2 2l9 6.5a1 1 0 0 1-.6 1.8H3.6a1 1 0 0 1-.6-1.8L12 9" /></svg>
          </span>
          <strong>{t('home.wardrobe')}</strong>
          <span>{t('home.wardrobeHint')}</span>
        </Link>
        <Link to="/subscription" className="shortcut shortcut-lilac">
          <span className="ico">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
          </span>
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
