import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { useI18n, type Lang } from '../i18n';

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  const { t } = useI18n();
  if (online) return null;
  return (
    <div className="offline" role="status">
      {t('offline.banner')}
    </div>
  );
}

export function LangSwitch() {
  const { lang, setLang } = useI18n();
  const opts: { v: Lang; label: string }[] = [
    { v: 'en', label: 'English' },
    { v: 'rw', label: 'Kinyarwanda' },
  ];
  return (
    <div className="lang" role="group" aria-label="Language / Ururimi">
      {opts.map((o) => (
        <button key={o.v} type="button" className={lang === o.v ? 'on' : ''} aria-pressed={lang === o.v} onClick={() => setLang(o.v)}>
          {o.v === 'en' ? 'EN' : 'RW'}
          <span className="sr-only"> {o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <img src="/favicon.png" alt="" width={28} height={28} />
      Laundry Dash
    </span>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  wardrobe: 'M12 4a2 2 0 1 1 2 2c-1 0-2 .7-2 2l9 6.5a1 1 0 0 1-.6 1.8H3.6a1 1 0 0 1-.6-1.8L12 8',
  bookings: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 13l2.5 2.5L16 11',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
};

export function CustomerLayout() {
  const { t } = useI18n();
  const { user } = useAuth();
  const tabs = [
    { to: '/', label: t('nav.home'), icon: ICONS.home, end: true },
    { to: '/wardrobe', label: t('nav.wardrobe'), icon: ICONS.wardrobe },
    { to: '/bookings', label: t('nav.bookings'), icon: ICONS.bookings },
    { to: '/account', label: t('nav.account'), icon: ICONS.account },
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          {user && (user.role === 'STAFF' || user.role === 'ADMIN') && <NavLink to="/staff" className="toplink">{t('nav.staff')}</NavLink>}
          {user?.role === 'RIDER' && <NavLink to="/rider" className="toplink">{t('nav.rider')}</NavLink>}
          <LangSwitch />
        </div>
      </header>
      <OfflineBanner />
      {user?.isDemo && <div className="demo-strip">{t('common.demo')}</div>}
      <main className="page" id="main">
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `tab${isActive ? ' tab-on' : ''}`}>
            <Icon d={tab.icon} />
            <span>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function PlainLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell shell-plain">
      <header className="topbar">
        <Brand />
        <LangSwitch />
      </header>
      <OfflineBanner />
      <main className="page" id="main">{children}</main>
    </div>
  );
}

export function PageTitle({ children, back }: { children: ReactNode; back?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="page-title">
      {back && (
        <button type="button" className="btn btn-quiet back" onClick={back}>
          ‹ {t('common.back')}
        </button>
      )}
      <h1>{children}</h1>
    </div>
  );
}
