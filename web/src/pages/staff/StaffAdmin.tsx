import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { patch, post, put } from '../../api';
import { useAuth } from '../../auth';
import { loadCatalog } from '../../catalog';
import { useI18n } from '../../i18n';
import type { Area, Category, Paged, Payment, Plan, Service, User } from '../../types';
import { Brand, LangSwitch, OfflineBanner } from '../../components/Layout';
import { Badge, Button, Checkbox, ErrorBox, Loading, Notice, payTone, SelectField, Sheet, TextArea, TextField, useLoad, useToast } from '../../components/ui';

/**
 * On phones, data tables become stacked cards. Each cell needs its column name as a label; rather than hand-writing
 * data-label on every <td>, copy it from the table's own header row whenever the content changes.
 */
function useCardLabels(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const label = () => {
      root.querySelectorAll<HTMLTableElement>('table.data').forEach((table) => {
        const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim() ?? '');
        table.querySelectorAll('tbody tr').forEach((tr) => {
          Array.from(tr.children).forEach((td, i) => {
            const want = heads[i] ?? '';
            if (td.getAttribute('data-label') !== want) td.setAttribute('data-label', want);
          });
        });
      });
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [ref]);
}

export function StaffLayout() {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useCardLabels(mainRef);
  // Keep the current section visible in the swipeable phone menu.
  useEffect(() => {
    const a = navRef.current?.querySelector<HTMLElement>('a.active');
    const bar = navRef.current;
    if (a && bar && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: a.offsetLeft - bar.clientWidth / 2 + a.clientWidth / 2, behavior: 'smooth' });
  }, [pathname]);
  const links: [string, string, boolean?][] = [
    ['/staff', t('staff.orders'), true],
    ['/staff/payments', t('staff.payments')],
    ['/staff/subscriptions', t('staff.subscriptions')],
    ['/staff/settings', t('staff.settings')],
    ['/staff/people', t('staff.users')],
    ['/staff/reports', t('staff.reports')],
  ];
  if (user?.role === 'ADMIN') links.push(['/staff/audit', t('staff.audit')]);
  return (
    <div className="shell shell-staff">
      <header className="topbar">
        <Brand />
        <nav ref={navRef} className="staff-nav" aria-label="Staff">
          {links.map(([to, label, end]) => <NavLink key={to} to={to} end={end}>{label}</NavLink>)}
        </nav>
        <div className="topbar-right">
          <span className="small staff-who">{user?.fullName} ({user?.role})</span>
          <LangSwitch />
          <button className="btn btn-quiet staff-signout" onClick={async () => { await logout(); nav('/login'); }} aria-label={t('auth.signOut')} title={t('auth.signOut')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" /></svg>
            <span className="staff-signout-text">{t('auth.signOut')}</span>
          </button>
        </div>
      </header>
      <OfflineBanner />
      {user?.isDemo && <div className="demo-strip">{t('common.demo')}</div>}
      <main ref={mainRef} className="page page-wide"><Outlet /></main>
    </div>
  );
}

function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
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

// ---------------- Settings ----------------
export function SettingsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [tab, setTab] = useState<'contact' | 'services' | 'areas' | 'categories' | 'plans' | 'slots'>('contact');
  const isAdmin = user?.role === 'ADMIN';
  return (
    <div className="stack">
      <h1>{t('staff.settings')}</h1>
      <div className="segmented wrap seg-scroll" role="group" aria-label={t('staff.settings')}>
        {(['contact', 'services', 'areas', 'categories', 'plans', 'slots'] as const).map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{t(`staff.${k}` as any)}</button>
        ))}
      </div>
      {!isAdmin && tab !== 'slots' && <Notice>{t('staff.adminOnly')}</Notice>}
      {tab === 'contact' && <ContactEditor admin={isAdmin} />}
      {tab === 'services' && <ServicesEditor admin={isAdmin} />}
      {tab === 'areas' && <AreasEditor admin={isAdmin} />}
      {tab === 'categories' && <CategoriesEditor admin={isAdmin} />}
      {tab === 'plans' && <PlansEditor admin={isAdmin} />}
      {tab === 'slots' && <SlotsEditor />}
    </div>
  );
}

function EditSheet({ title, onClose, onSubmit, s, children }: { title: string; onClose: () => void; onSubmit: () => Promise<unknown>; s: ReturnType<typeof useSave>; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Sheet title={title} onClose={onClose}>
      <form className="stack" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (await s.run(onSubmit)) { loadCatalog(true); onClose(); } }}>
        {children}
        <ErrorBox error={s.error} />
        <div className="actions"><Button type="button" variant="quiet" onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" busy={s.busy}>{t('common.save')}</Button></div>
      </form>
    </Sheet>
  );
}

/** WhatsApp and phone numbers customers use to reach the business (Home, sign-in help, order pages). */
function ContactEditor({ admin }: { admin: boolean }) {
  const cur = useLoad<{ contact: { phone: string; whatsapp: string; source: 'settings' | 'environment' } }>('/admin/settings/contact');
  const [f, setF] = useState<{ phone: string; whatsapp: string } | null>(null);
  const s = useSave();
  const toast = useToast();
  useEffect(() => {
    if (cur.data && !f) setF({ phone: cur.data.contact.phone, whatsapp: '+' + cur.data.contact.whatsapp });
  }, [cur.data, f]);
  if (!cur.data || !f) return <Loading />;
  const c = cur.data.contact;
  return (
    <form className="panel stack contact-panel" onSubmit={async (e) => { e.preventDefault(); if (await s.run(() => put('/admin/settings/contact', f))) { toast('Contact numbers saved'); cur.reload(); setF(null); loadCatalog(true); } }}>
      <h2>Customer contact numbers</h2>
      <p className="hint">Shown to customers on the Home screen, on order pages and on the sign-in help page. Changes apply immediately.</p>
      <div className="row-2">
        <TextField label="WhatsApp number" hint="The number customers chat with, e.g. 078 123 4567" type="tel" inputMode="tel" value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} disabled={!admin} required />
        <TextField label="Phone number for calls" hint="The number customers call, e.g. 078 123 4567" type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} disabled={!admin} required />
      </div>
      <div className="actions">
        <a className="btn btn-whatsapp" href={`https://wa.me/${c.whatsapp}`} target="_blank" rel="noopener noreferrer">Test WhatsApp link</a>
        <a className="btn btn-secondary" href={`tel:${c.phone}`}>Test call link</a>
      </div>
      {c.source === 'environment' && <Notice tone="warn">These are the default numbers from the server setup. Save here to manage them from the app.</Notice>}
      <ErrorBox error={s.error} />
      {admin && <Button type="submit" busy={s.busy}>Save contact numbers</Button>}
    </form>
  );
}

function ServicesEditor({ admin }: { admin: boolean }) {
  const { money } = useI18n();
  const list = useLoad<{ items: Service[] }>('/admin/services');
  const cats = useLoad<{ items: Category[] }>('/admin/categories');
  const [edit, setEdit] = useState<any | null>(null);
  const s = useSave();
  const blank = { code: '', nameEn: '', nameRw: '', descriptionEn: '', descriptionRw: '', kind: 'CLOTHES', pricingUnit: 'ITEM', unitPrice: 0, minCharge: 0, turnaroundHours: 48, active: true, categoryPrices: [] };
  return (
    <>
      {list.loading && !list.data && <Loading />}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Unit</th><th className="num">Price</th><th className="num">Min</th><th>Overrides</th><th>Active</th><th /></tr></thead>
          <tbody>
            {list.data?.items.map((x) => (
              <tr key={x.id}>
                <td>{x.code}</td><td>{x.nameEn}<span className="block muted small">{x.nameRw}</span></td><td>{x.kind}</td><td>{x.pricingUnit}</td>
                <td className="num">{money(x.unitPrice)}</td><td className="num">{money(x.minCharge)}</td>
                <td className="small">{x.categoryPrices.map((p) => `${cats.data?.items.find((c) => c.id === p.categoryId)?.code}: ${p.unitPrice}`).join(', ')}</td>
                <td>{x.active ? '✓' : '—'}</td>
                <td>{admin && <Button variant="quiet" onClick={() => setEdit({ ...x })}>Edit</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {admin && <Button variant="secondary" onClick={() => setEdit({ ...blank })}>Add service</Button>}
      {edit && (
        <EditSheet title={edit.id ? `Edit ${edit.code}` : 'New service'} s={s} onClose={() => { setEdit(null); list.reload(); }}
          onSubmit={() => { const { id, ...body } = edit; return id ? put(`/admin/services/${id}`, body) : post('/admin/services', body); }}>
          <div className="row-2">
            <TextField label="Code" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} required />
            <SelectField label="Kind" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}><option>CLOTHES</option><option>SHOES</option></SelectField>
            <TextField label="Name (English)" value={edit.nameEn} onChange={(e) => setEdit({ ...edit, nameEn: e.target.value })} required />
            <TextField label="Name (Kinyarwanda)" value={edit.nameRw} onChange={(e) => setEdit({ ...edit, nameRw: e.target.value })} required />
            <SelectField label="Priced per" value={edit.pricingUnit} onChange={(e) => setEdit({ ...edit, pricingUnit: e.target.value })}><option value="ITEM">Item</option><option value="KG">Kg</option></SelectField>
            <TextField label="Unit price (RWF)" type="number" min={0} value={edit.unitPrice} onChange={(e) => setEdit({ ...edit, unitPrice: Number(e.target.value) })} />
            <TextField label="Minimum charge (RWF)" type="number" min={0} value={edit.minCharge} onChange={(e) => setEdit({ ...edit, minCharge: Number(e.target.value) })} />
            <TextField label="Turnaround (hours)" type="number" min={1} value={edit.turnaroundHours} onChange={(e) => setEdit({ ...edit, turnaroundHours: Number(e.target.value) })} />
          </div>
          <TextArea label="Description (English)" optional value={edit.descriptionEn} onChange={(e) => setEdit({ ...edit, descriptionEn: e.target.value })} />
          <TextArea label="Description (Kinyarwanda)" optional value={edit.descriptionRw} onChange={(e) => setEdit({ ...edit, descriptionRw: e.target.value })} />
          <fieldset><legend>Category price overrides (RWF, blank = unit price)</legend>
            <div className="row-2">
              {cats.data?.items.filter((c) => c.kind === edit.kind).map((c) => {
                const cur = edit.categoryPrices.find((p: any) => p.categoryId === c.id);
                return <TextField key={c.id} label={c.nameEn} type="number" min={0} value={cur?.unitPrice ?? ''} onChange={(e) => {
                  const rest = edit.categoryPrices.filter((p: any) => p.categoryId !== c.id);
                  setEdit({ ...edit, categoryPrices: e.target.value === '' ? rest : [...rest, { categoryId: c.id, unitPrice: Number(e.target.value) }] });
                }} />;
              })}
            </div>
          </fieldset>
          <Checkbox label="Active (customers can book it)" checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
          <p className="hint">Existing orders keep the price they were booked at. Changes are recorded in the audit log.</p>
        </EditSheet>
      )}
    </>
  );
}

function AreasEditor({ admin }: { admin: boolean }) {
  const { money } = useI18n();
  const list = useLoad<{ items: Area[] }>('/admin/service-areas');
  const [edit, setEdit] = useState<any | null>(null);
  const s = useSave();
  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Area</th><th>District</th><th>Landmarks</th><th className="num">Pickup</th><th className="num">Delivery</th><th>Active</th><th /></tr></thead>
          <tbody>{list.data?.items.map((a) => (
            <tr key={a.id}><td>{a.name}</td><td>{a.district}</td><td className="small">{a.landmarks.join(', ')}</td><td className="num">{money(a.pickupFee)}</td><td className="num">{money(a.deliveryFee)}</td><td>{a.active ? '✓' : '—'}</td>
              <td>{admin && <Button variant="quiet" onClick={() => setEdit({ ...a, landmarks: a.landmarks.join(', ') })}>Edit</Button>}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {admin && <Button variant="secondary" onClick={() => setEdit({ code: '', name: '', district: 'Gasabo', landmarks: '', pickupFee: 1000, deliveryFee: 1000, active: true })}>Add area</Button>}
      {edit && (
        <EditSheet title={edit.id ? `Edit ${edit.name}` : 'New area'} s={s} onClose={() => { setEdit(null); list.reload(); }}
          onSubmit={() => { const { id, ...b } = edit; return id ? put(`/admin/service-areas/${id}`, b) : post('/admin/service-areas', b); }}>
          <div className="row-2">
            <TextField label="Code" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} required />
            <TextField label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required />
            <SelectField label="District" value={edit.district} onChange={(e) => setEdit({ ...edit, district: e.target.value })}><option>Gasabo</option><option>Kicukiro</option><option>Nyarugenge</option></SelectField>
            <TextField label="Pickup fee (RWF)" type="number" min={0} value={edit.pickupFee} onChange={(e) => setEdit({ ...edit, pickupFee: Number(e.target.value) })} />
            <TextField label="Delivery fee (RWF)" type="number" min={0} value={edit.deliveryFee} onChange={(e) => setEdit({ ...edit, deliveryFee: Number(e.target.value) })} />
          </div>
          <TextField label="Landmarks (comma separated)" value={edit.landmarks} onChange={(e) => setEdit({ ...edit, landmarks: e.target.value })} />
          <Checkbox label="Active" checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
        </EditSheet>
      )}
    </>
  );
}

function CategoriesEditor({ admin }: { admin: boolean }) {
  const list = useLoad<{ items: Category[] }>('/admin/categories');
  const [edit, setEdit] = useState<any | null>(null);
  const s = useSave();
  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Code</th><th>Kind</th><th>English</th><th>Kinyarwanda</th><th>For</th><th>Customers</th><th className="num">Typical life</th><th>Active</th><th /></tr></thead>
          <tbody>{list.data?.items.map((c) => (
            <tr key={c.id}><td>{c.code}</td><td>{c.kind}</td><td>{c.nameEn}</td><td>{c.nameRw}</td><td>{c.gender === 'ANY' ? 'Everyone' : c.gender === 'FEMALE' ? 'Women' : 'Men'}</td><td>{c.segment === 'BUSINESS' ? 'Business' : 'Personal'}</td><td className="num">{c.lifespanMonths} mo</td><td>{c.active ? '✓' : '—'}</td><td>{admin && <Button variant="quiet" onClick={() => setEdit({ ...c })}>Edit</Button>}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {admin && <Button variant="secondary" onClick={() => setEdit({ code: '', kind: 'CLOTHES', nameEn: '', nameRw: '', gender: 'ANY', segment: 'PERSONAL', lifespanMonths: 36, active: true })}>Add garment type</Button>}
      {edit && (
        <EditSheet title={edit.id ? `Edit ${edit.code}` : 'New garment type'} s={s} onClose={() => { setEdit(null); list.reload(); }}
          onSubmit={() => { const { id, ...b } = edit; return id ? put(`/admin/categories/${id}`, b) : post('/admin/categories', b); }}>
          <div className="row-2">
            <TextField label="Code" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} required />
            <SelectField label="Kind" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}><option>CLOTHES</option><option>SHOES</option></SelectField>
            <TextField label="English" value={edit.nameEn} onChange={(e) => setEdit({ ...edit, nameEn: e.target.value })} required />
            <TextField label="Kinyarwanda" value={edit.nameRw} onChange={(e) => setEdit({ ...edit, nameRw: e.target.value })} required />
            <SelectField label="Show to" value={edit.gender} onChange={(e) => setEdit({ ...edit, gender: e.target.value })}><option value="ANY">Everyone</option><option value="FEMALE">Women</option><option value="MALE">Men</option></SelectField>
            <SelectField label="Customer type" value={edit.segment} onChange={(e) => setEdit({ ...edit, segment: e.target.value })}><option value="PERSONAL">Personal</option><option value="BUSINESS">Business (linens, uniforms…)</option></SelectField>
            <TextField label="Typical life (months)" hint="Used to estimate depreciation" type="number" min={1} max={240} value={edit.lifespanMonths} onChange={(e) => setEdit({ ...edit, lifespanMonths: Number(e.target.value) })} />
          </div>
          <p className="hint">Personal customers see types for everyone plus their chosen gender. Business customers see business types first, then all others.</p>
          <Checkbox label="Active" checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
        </EditSheet>
      )}
    </>
  );
}

function PlansEditor({ admin }: { admin: boolean }) {
  const { money } = useI18n();
  const list = useLoad<{ items: Plan[] }>('/admin/subscription-plans');
  const svcs = useLoad<{ items: Service[] }>('/admin/services');
  const [edit, setEdit] = useState<any | null>(null);
  const s = useSave();
  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Plan</th><th className="num">Price</th><th>Validity</th><th>Allowance</th><th>Free trips</th><th>Overage</th><th>Active</th><th /></tr></thead>
          <tbody>{list.data?.items.map((p) => (
            <tr key={p.id}><td>{p.nameEn}<span className="block muted small">{p.code}</span></td><td className="num">{money(p.price)}</td><td>{p.validityDays} d</td><td>{p.allowanceQuantity} {p.allowanceUnit}</td><td>{p.freeTrips}</td><td>{p.overageDiscountPercent}% off</td><td>{p.active ? '✓' : '—'}</td>
              <td>{admin && <Button variant="quiet" onClick={() => setEdit({ ...p })}>Edit</Button>}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {admin && <Button variant="secondary" onClick={() => setEdit({ code: '', nameEn: '', nameRw: '', descriptionEn: '', descriptionRw: '', price: 0, validityDays: 30, allowanceUnit: 'KG', allowanceQuantity: 10, freeTrips: 2, overageDiscountPercent: 0, includedServiceIds: [], active: true })}>Add plan</Button>}
      {edit && (
        <EditSheet title={edit.id ? `Edit ${edit.code}` : 'New plan'} s={s} onClose={() => { setEdit(null); list.reload(); }}
          onSubmit={() => { const { id, ...b } = edit; return id ? put(`/admin/subscription-plans/${id}`, b) : post('/admin/subscription-plans', b); }}>
          <div className="row-2">
            <TextField label="Code" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} required />
            <TextField label="Price (RWF)" type="number" min={0} value={edit.price} onChange={(e) => setEdit({ ...edit, price: Number(e.target.value) })} />
            <TextField label="Name (English)" value={edit.nameEn} onChange={(e) => setEdit({ ...edit, nameEn: e.target.value })} required />
            <TextField label="Name (Kinyarwanda)" value={edit.nameRw} onChange={(e) => setEdit({ ...edit, nameRw: e.target.value })} required />
            <TextField label="Validity (days)" type="number" min={1} value={edit.validityDays} onChange={(e) => setEdit({ ...edit, validityDays: Number(e.target.value) })} />
            <SelectField label="Allowance unit" value={edit.allowanceUnit} onChange={(e) => setEdit({ ...edit, allowanceUnit: e.target.value, includedServiceIds: [] })}><option value="KG">Kg</option><option value="ITEM">Items</option></SelectField>
            <TextField label="Allowance quantity" type="number" min={0} value={edit.allowanceQuantity} onChange={(e) => setEdit({ ...edit, allowanceQuantity: Number(e.target.value) })} />
            <TextField label="Free pickup+delivery trips" type="number" min={0} value={edit.freeTrips} onChange={(e) => setEdit({ ...edit, freeTrips: Number(e.target.value) })} />
            <TextField label="Overage discount %" type="number" min={0} max={100} value={edit.overageDiscountPercent} onChange={(e) => setEdit({ ...edit, overageDiscountPercent: Number(e.target.value) })} />
          </div>
          <TextArea label="Description (English)" value={edit.descriptionEn} onChange={(e) => setEdit({ ...edit, descriptionEn: e.target.value })} />
          <TextArea label="Description (Kinyarwanda)" value={edit.descriptionRw} onChange={(e) => setEdit({ ...edit, descriptionRw: e.target.value })} />
          <fieldset><legend>Included services (must be priced per {edit.allowanceUnit === 'KG' ? 'kg' : 'item'})</legend>
            {svcs.data?.items.filter((x) => x.pricingUnit === edit.allowanceUnit).map((x) => (
              <Checkbox key={x.id} label={x.nameEn} checked={edit.includedServiceIds.includes(x.id)} onChange={(v) => setEdit({ ...edit, includedServiceIds: v ? [...edit.includedServiceIds, x.id] : edit.includedServiceIds.filter((i: string) => i !== x.id) })} />
            ))}
          </fieldset>
          <Checkbox label="Active (customers can buy it)" checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
          <p className="hint">Customers who already bought this plan keep the terms they paid for.</p>
        </EditSheet>
      )}
    </>
  );
}

const kigaliDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Kigali' });

function SlotsEditor() {
  const { t, dayLabel, timeRange } = useI18n();
  const list = useLoad<{ items: { id: string; startsAt: string; endsAt: string; capacity: number; booked: number; active: boolean }[] }>('/admin/pickup-slots?days=14');
  // One day at a time keeps the list short on a phone (14 days × 5 slots would otherwise be ~70 rows).
  const days = useMemo(() => {
    const m = new Map<string, [string, string, number]>();
    for (const x of list.data?.items ?? []) {
      const k = kigaliDay(x.startsAt);
      const cur = m.get(k);
      m.set(k, cur ? [k, cur[1], cur[2] + 1] : [k, x.startsAt, 1]);
    }
    return [...m.values()];
  }, [list.data]);
  const [picked, setDay] = useState<string | null>(null);
  const day = picked && days.some((d) => d[0] === picked) ? picked : days[0]?.[0] ?? null;
  const slotsOfDay = (list.data?.items ?? []).filter((x) => kigaliDay(x.startsAt) === day);
  const [g, setG] = useState({ days: 7, startHour: 8, endHour: 18, slotMinutes: 120, capacity: 4 });
  const s = useSave();
  const [msg, setMsg] = useState('');
  return (
    <div className="stack">
      <form className="panel" onSubmit={async (e) => { e.preventDefault(); setMsg(''); await s.run(async () => { const r = await post<{ created: number }>('/admin/pickup-slots/generate', g); setMsg(`${r.created} slot(s) created`); list.reload(); }); }}>
        <h2>{t('staff.generateSlots')}</h2>
        <div className="row-2">
          <TextField label="Days ahead" type="number" min={1} max={31} value={g.days} onChange={(e) => setG({ ...g, days: Number(e.target.value) })} />
          <TextField label="Capacity per slot" type="number" min={1} value={g.capacity} onChange={(e) => setG({ ...g, capacity: Number(e.target.value) })} />
          <TextField label="First slot starts (hour)" type="number" min={5} max={20} value={g.startHour} onChange={(e) => setG({ ...g, startHour: Number(e.target.value) })} />
          <TextField label="Last slot ends (hour)" type="number" min={6} max={22} value={g.endHour} onChange={(e) => setG({ ...g, endHour: Number(e.target.value) })} />
          <SelectField label="Slot length" value={g.slotMinutes} onChange={(e) => setG({ ...g, slotMinutes: Number(e.target.value) })}>{[60, 90, 120, 180].map((m) => <option key={m} value={m}>{m} min</option>)}</SelectField>
        </div>
        <p className="hint">Monday–Saturday, Kigali time. Existing slots are left unchanged.</p>
        <ErrorBox error={s.error} />
        {msg && <Notice tone="ok">{msg}</Notice>}
        <Button type="submit" busy={s.busy}>{t('staff.generateSlots')}</Button>
      </form>
      {days.length > 0 && (
        <div className="day-chips" role="group" aria-label="Day">
          {days.map(([key, iso, n]) => (
            <button key={key} type="button" className={`chip${day === key ? ' on' : ''}`} aria-pressed={day === key} onClick={() => setDay(key)}>
              {dayLabel(iso)} <span className="chip-count">{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="data keep-table">
          <thead><tr><th>Time</th><th className="num">Booked</th><th>Capacity</th><th>Open</th></tr></thead>
          <tbody>{slotsOfDay.map((x) => (
            <tr key={x.id}>
              <td>{timeRange(x.startsAt, x.endsAt)}</td><td className="num">{x.booked}</td>
              <td><input aria-label="Capacity" type="number" inputMode="numeric" min={x.booked} defaultValue={x.capacity} onBlur={(e) => Number(e.target.value) !== x.capacity && s.run(() => patch(`/admin/pickup-slots/${x.id}`, { capacity: Number(e.target.value) })).then(list.reload)} /></td>
              <td><input aria-label="Open for booking" type="checkbox" checked={x.active} onChange={(e) => s.run(() => patch(`/admin/pickup-slots/${x.id}`, { active: e.target.checked })).then(list.reload)} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------- People ----------------
export function PeoplePage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useLoad<Paged<User & { status: string }>>(`/admin/users?pageSize=50${role ? `&role=${role}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  const [creating, setCreating] = useState<any | null>(null);
  const [reset, setReset] = useState<{ id: string; note: string; link?: string } | null>(null);
  const s = useSave();
  const isAdmin = user?.role === 'ADMIN';
  return (
    <div className="stack">
      <h1>{t('staff.users')}</h1>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <TextField label={t('staff.search')} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        <SelectField label={t('staff.role')} value={role} onChange={(e) => setRole(e.target.value)}><option value="">All</option>{['CUSTOMER', 'RIDER', 'STAFF', 'ADMIN'].map((r) => <option key={r}>{r}</option>)}</SelectField>
        <Button type="submit" variant="secondary">{t('staff.apply')}</Button>
      </form>
      <ErrorBox error={s.error || list.error} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Name</th><th>Email / phone</th><th>{t('staff.role')}</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data?.items.map((u) => (
            <tr key={u.id}>
              <td>{u.fullName} {u.isDemo && <Badge tone="warn">DEMO</Badge>}</td>
              <td className="small">{u.email}<span className="block">{u.phone}</span></td>
              <td>{isAdmin && u.id !== user?.id ? (
                <select aria-label={t('staff.role')} value={u.role} onChange={(e) => confirm(`Change ${u.fullName} to ${e.target.value}? They will be signed out.`) && s.run(() => patch(`/admin/users/${u.id}`, { role: e.target.value })).then(list.reload)}>
                  {['CUSTOMER', 'RIDER', 'STAFF', 'ADMIN'].map((r) => <option key={r}>{r}</option>)}
                </select>) : u.role}</td>
              <td>{u.status}</td>
              <td className="inline-form">{isAdmin && u.id !== user?.id && (
                <>
                  <Button variant="quiet" onClick={() => s.run(() => patch(`/admin/users/${u.id}`, { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })).then(list.reload)}>{u.status === 'ACTIVE' ? t('staff.disable') : t('staff.enable')}</Button>
                  {(u.role === 'CUSTOMER' || u.role === 'RIDER') && <Button variant="quiet" onClick={() => setReset({ id: u.id, note: '' })}>{t('staff.resetLink')}</Button>}
                </>)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {isAdmin && <Button variant="secondary" onClick={() => setCreating({ fullName: '', email: '', phone: '', password: '', role: 'RIDER' })}>{t('staff.newUser')}</Button>}
      {creating && (
        <EditSheet title={t('staff.newUser')} s={s} onClose={() => { setCreating(null); list.reload(); }} onSubmit={() => post('/admin/users', { ...creating, email: creating.email || undefined, phone: creating.phone || undefined })}>
          <TextField label={t('auth.fullName')} value={creating.fullName} onChange={(e) => setCreating({ ...creating, fullName: e.target.value })} required />
          <TextField label={t('auth.email')} optional value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} />
          <TextField label={t('auth.phone')} optional value={creating.phone} onChange={(e) => setCreating({ ...creating, phone: e.target.value })} />
          <TextField label={`${t('auth.password')} (temporary)`} type="password" autoComplete="new-password" value={creating.password} onChange={(e) => setCreating({ ...creating, password: e.target.value })} required minLength={8} />
          <SelectField label={t('staff.role')} value={creating.role} onChange={(e) => setCreating({ ...creating, role: e.target.value })}>{['RIDER', 'STAFF', 'ADMIN', 'CUSTOMER'].map((r) => <option key={r}>{r}</option>)}</SelectField>
        </EditSheet>
      )}
      {reset && (
        <Sheet title={t('staff.resetLink')} onClose={() => setReset(null)}>
          {reset.link ? (
            <div className="stack">
              <Notice tone="warn">Give this link only to the verified account owner. It works once, for 30 minutes.</Notice>
              <input readOnly value={reset.link} onFocus={(e) => e.target.select()} aria-label="Reset link" />
            </div>
          ) : (
            <form className="stack" onSubmit={async (e) => { e.preventDefault(); await s.run(async () => { const r = await post<{ link: string }>(`/admin/users/${reset.id}/password-reset-link`, { verificationNote: reset.note }); setReset({ ...reset, link: r.link }); }); }}>
              <p className="hint">Verify identity first: in person with ID, or call back the registered number and confirm a recent order reference.</p>
              <TextArea label={t('staff.resetVerify')} value={reset.note} onChange={(e) => setReset({ ...reset, note: e.target.value })} required minLength={10} />
              <ErrorBox error={s.error} />
              <Button type="submit" busy={s.busy}>{t('staff.resetLink')}</Button>
            </form>
          )}
        </Sheet>
      )}
    </div>
  );
}

// ---------------- Payments / Subscriptions / Reports / Audit ----------------
export function PaymentsPage() {
  const { t, money, dateTime } = useI18n();
  const [status, setStatus] = useState('PENDING');
  const list = useLoad<Paged<Payment & { customerName: string; orderReference: string | null }>>(`/admin/payments?pageSize=50${status ? `&status=${status}` : ''}`);
  const s = useSave();
  return (
    <div className="stack">
      <h1>{t('staff.payments')}</h1>
      <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All</option>{['PENDING', 'SUCCESSFUL', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].map((x) => <option key={x} value={x}>{t(`pay.${x}` as any)}</option>)}
      </SelectField>
      <ErrorBox error={s.error || list.error} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>{t('staff.customer')}</th><th>For</th><th>Method</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>{list.data?.items.map((p) => (
            <tr key={p.id}>
              <td className="small">{dateTime(p.createdAt)}</td><td>{p.customerName}</td>
              <td>{p.orderId ? <a href={`/staff/orders/${p.orderId}`}>{p.orderReference}</a> : 'Subscription'}</td>
              <td>{p.method}{p.testMode && <> <Badge tone="warn">TEST</Badge></>}{p.manualReference && <span className="block small">{p.manualReference}</span>}</td>
              <td className="num">{money(p.amount)}</td><td><Badge tone={payTone(p.status)}>{t(`pay.${p.status}` as any)}</Badge></td>
              <td>{p.status === 'PENDING' && p.provider && <Button variant="quiet" busy={s.busy} onClick={() => s.run(() => post(`/admin/payments/${p.id}/check-status`, {})).then(list.reload)}>{t('staff.checkStatus')}</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="hint">Pending payments stay pending until the provider confirms. If a customer says they paid but it still shows pending, check the provider, then record an issue (PAYMENT_UNCERTAIN) on the order.</p>
    </div>
  );
}

export function SubscriptionsAdminPage() {
  const { t, money, date } = useI18n();
  const list = useLoad<Paged<any>>('/admin/subscriptions?pageSize=50');
  const [pay, setPay] = useState<any | null>(null);
  const s = useSave();
  return (
    <div className="stack">
      <h1>{t('staff.subscriptions')}</h1>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{t('staff.customer')}</th><th>Plan</th><th>Status</th><th>Period</th><th /></tr></thead>
          <tbody>{list.data?.items.map((x) => (
            <tr key={x.id}>
              <td>{x.customerName}<span className="block small muted">{x.customerPhone ?? x.customerEmail}</span></td>
              <td>{x.plan.nameEn} · {money(x.plan.price)}</td>
              <td><Badge tone={x.status === 'ACTIVE' ? 'ok' : x.status === 'PENDING_PAYMENT' ? 'warn' : 'neutral'}>{x.status}</Badge></td>
              <td className="small">{x.startsAt ? `${date(x.startsAt)} – ${date(x.endsAt)}` : '—'}</td>
              <td>{x.status === 'PENDING_PAYMENT' && <Button variant="quiet" onClick={() => setPay({ id: x.id, amount: x.plan.price, method: 'CASH', reference: '' })}>{t('staff.activate')}</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {pay && (
        <EditSheet title={t('staff.activate')} s={s} onClose={() => { setPay(null); list.reload(); }} onSubmit={() => post(`/admin/subscriptions/${pay.id}/payments/manual`, { amount: pay.amount, method: pay.method, reference: pay.reference || undefined })}>
          <p>{money(pay.amount)}</p>
          <SelectField label={t('staff.method')} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="CASH">Cash</option><option value="MANUAL_MOBILE_MONEY">Mobile Money to business number</option><option value="BANK_TRANSFER">Bank transfer</option></SelectField>
          {pay.method !== 'CASH' && <TextField label={t('staff.reference')} value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} required />}
        </EditSheet>
      )}
    </div>
  );
}

export function ReportsPage() {
  const { t, money } = useI18n();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const [r, setR] = useState({ from: monthAgo, to: today });
  const sum = useLoad<any>(`/admin/reports/summary?from=${r.from}&to=${r.to}`);
  return (
    <div className="stack">
      <h1>{t('staff.reports')}</h1>
      <div className="filters">
        <TextField label={t('staff.from')} type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} />
        <TextField label={t('staff.to')} type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} />
      </div>
      {sum.loading && !sum.data ? <Loading /> : <ErrorBox error={sum.error} />}
      {sum.data && (
        <dl className="figures">
          <div><dt>Orders</dt><dd>{sum.data.orders}</dd></div>
          <div><dt>Delivered</dt><dd>{sum.data.delivered}</dd></div>
          <div><dt>Open</dt><dd>{sum.data.open}</dd></div>
          <div><dt>Cancelled</dt><dd>{sum.data.cancelled}</dd></div>
          <div><dt>Order value</dt><dd>{money(sum.data.order_value)}</dd></div>
          <div><dt>Collected (net)</dt><dd>{money(sum.data.collected)}</dd></div>
          <div><dt>Pending payments</dt><dd>{sum.data.pending_payments}</dd></div>
          <div><dt>Open issues</dt><dd>{sum.data.openIssues}</dd></div>
        </dl>
      )}
      <div className="actions">
        <a className="btn btn-secondary" href={`/api/v1/admin/reports/orders.csv?from=${r.from}&to=${r.to}`}>{t('staff.download')}: {t('staff.orders')}</a>
        <a className="btn btn-secondary" href={`/api/v1/admin/reports/payments.csv?from=${r.from}&to=${r.to}`}>{t('staff.download')}: {t('staff.payments')}</a>
      </div>
    </div>
  );
}

export function AuditPage() {
  const { t, dateTime } = useI18n();
  const [page, setPage] = useState(1);
  const list = useLoad<Paged<any>>(`/admin/audit-logs?page=${page}&pageSize=50`);
  return (
    <div className="stack">
      <h1>{t('staff.audit')}</h1>
      <ErrorBox error={list.error} />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
          <tbody>{list.data?.items.map((a) => (
            <tr key={a.id}><td className="small">{dateTime(a.createdAt)}</td><td>{a.actor ?? 'system'}</td><td>{a.action}</td><td className="small">{a.entityType} {a.entityId?.slice(0, 8)}</td><td className="small mono-ish">{JSON.stringify(a.after ?? '').slice(0, 140)}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="pager">
        <Button variant="quiet" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button><span>{page}</span>
        <Button variant="quiet" disabled={!list.data || page * 50 >= list.data.total} onClick={() => setPage(page + 1)}>›</Button>
      </div>
    </div>
  );
}
