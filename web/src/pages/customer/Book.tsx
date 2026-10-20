import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { newKey, post } from '../../api';
import { unitPriceFor, useCatalog, useLocalName } from '../../catalog';
import { useI18n } from '../../i18n';
import type { Address, OrderDetail, Paged, Pricing, Service, Slot, WardrobeItem } from '../../types';
import { PageTitle } from '../../components/Layout';
import { Button, Checkbox, ColorDot, ErrorBox, Loading, Notice, SelectField, TextArea, TextField, useLoad, useToast } from '../../components/ui';

interface DraftItem {
  key: string;
  wardrobeItemId?: string;
  name: string;
  categoryId: string;
  serviceId: string;
  quantity: number;
  saveToWardrobe?: boolean;
}

const STEPS = ['items', 'pickup', 'delivery', 'review'] as const;
type Step = (typeof STEPS)[number];

export function PriceBreakdown({ pricing }: { pricing: Pricing }) {
  const { t, money } = useI18n();
  return (
    <table className="price">
      <tbody>
        {pricing.lines.map((l) => (
          <tr key={l.ref}>
            <th scope="row">
              {l.label}
              <span className="muted small"> · {l.serviceName} · {l.quantity} {l.pricingUnit === 'KG' ? 'kg' : '×'} {money(l.unitPrice)}</span>
              {l.coveredQuantity > 0 && <span className="ok-text small"> · {t('book.covered', { qty: `${l.coveredQuantity} ${l.pricingUnit === 'KG' ? 'kg' : ''}` })}</span>}
            </th>
            <td>{money(l.net)}</td>
          </tr>
        ))}
        {pricing.minimumChargeTopUps.map((m) => (
          <tr key={m.serviceName}><th scope="row">{t('book.minCharge', { service: m.serviceName })}</th><td>{money(m.amount)}</td></tr>
        ))}
        {pricing.adjustments.map((a, i) => (
          <tr key={i}><th scope="row">{a.description}</th><td>{money(a.amount)}</td></tr>
        ))}
        <tr><th scope="row">{t('book.pickupFee')}</th><td>{money(pricing.pickupFee)}</td></tr>
        <tr><th scope="row">{t('book.deliveryFee')}</th><td>{money(pricing.deliveryFee)}</td></tr>
        {pricing.feesWaived > 0 && <tr className="ok-text"><th scope="row">{t('book.feesWaived')}</th><td>−{money(pricing.feesWaived)}</td></tr>}
      </tbody>
      <tfoot>
        <tr><th scope="row">{t('order.total')}</th><td>{money(pricing.total)}</td></tr>
      </tfoot>
    </table>
  );
}

export function SlotPicker({ value, onChange, slots }: { value: string; onChange: (id: string) => void; slots: Slot[] }) {
  const { t, slotLabel } = useI18n();
  if (slots.filter((s) => s.available).length === 0) return <Notice tone="warn">{t('book.noSlots')}</Notice>;
  return (
    <fieldset className="slots">
      <legend>{t('book.slot')}</legend>
      {slots.map((s) => (
        <label key={s.id} className={`slot${value === s.id ? ' slot-on' : ''}${!s.available ? ' slot-full' : ''}`}>
          <input type="radio" name="slot" value={s.id} checked={value === s.id} disabled={!s.available} onChange={() => onChange(s.id)} />
          <span>{slotLabel(s.startsAt, s.endsAt)}</span>
          <span className="muted small">{s.available ? t('book.slotLeft', { n: s.remaining }) : '—'}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ItemAdder({ services, onAdd, wardrobe, initialWid = '' }: { services: Service[]; onAdd: (d: DraftItem) => void; wardrobe: WardrobeItem[]; initialWid?: string }) {
  const { t, money } = useI18n();
  const name = useLocalName();
  const { catalog } = useCatalog();
  const [mode, setMode] = useState<'manual' | 'wardrobe'>(wardrobe.length || initialWid ? 'wardrobe' : 'manual');
  const [wid, setWid] = useState(initialWid);
  const [desc, setDesc] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [qty, setQty] = useState('1');
  const [save, setSave] = useState(false);
  const [err, setErr] = useState('');

  const w = wardrobe.find((x) => x.id === wid);
  const kind = mode === 'wardrobe' ? w?.kind : catalog?.categories.find((c) => c.id === categoryId)?.kind;
  const effectiveCategory = mode === 'wardrobe' ? w?.categoryId : categoryId;
  const options = services.filter((s) => !kind || s.kind === kind);
  const svc = services.find((s) => s.id === serviceId);
  const isKg = svc?.pricingUnit === 'KG';

  useEffect(() => {
    if (svc && kind && svc.kind !== kind) setServiceId('');
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (w && !isKg) setQty(String(w.quantity));
  }, [wid]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    const q = Number(qty);
    if (mode === 'wardrobe' && !w) return setErr(t('book.fromWardrobe'));
    if (mode === 'manual' && (!desc.trim() || !categoryId)) return setErr(`${t('wardrobe.name')} / ${t('wardrobe.category')}`);
    if (!svc) return setErr(t('book.chooseService'));
    if (!(q > 0) || (isKg ? q < 0.5 || q > 50 : !Number.isInteger(q) || q > 100)) return setErr(isKg ? t('book.estimatedKg') : t('wardrobe.quantity'));
    setErr('');
    onAdd({ key: newKey(), wardrobeItemId: w?.id, name: w?.name ?? desc.trim(), categoryId: effectiveCategory!, serviceId, quantity: q, saveToWardrobe: mode === 'manual' && save });
    setDesc('');
    setWid('');
    setQty('1');
    setSave(false);
  };

  return (
    <div className="adder">
      <div className="segmented">
        <button type="button" className={mode === 'wardrobe' ? 'on' : ''} aria-pressed={mode === 'wardrobe'} onClick={() => setMode('wardrobe')} disabled={!wardrobe.length}>{t('book.fromWardrobe')}</button>
        <button type="button" className={mode === 'manual' ? 'on' : ''} aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>{t('book.addManual')}</button>
      </div>
      {mode === 'wardrobe' ? (
        <>
        <SelectField label={t('book.fromWardrobe')} value={wid} onChange={(e) => setWid(e.target.value)}>
          <option value="">—</option>
          {wardrobe.map((x) => <option key={x.id} value={x.id}>{x.name}{x.color ? ` (${x.color})` : ''}</option>)}
        </SelectField>
        {w && (
          <div className="item-line small">
            {w.photoUrl ? <img src={w.photoUrl} alt="" width={44} height={44} style={{ borderRadius: 10, objectFit: 'cover' }} /> : <ColorDot hex={w.colorHex} name={w.color} size={18} />}
            <span>{w.name}{w.careNotes ? `: ${w.careNotes}` : ''}</span>
          </div>
        )}
        </>
      ) : (
        <>
          <TextField label={t('wardrobe.name')} placeholder={t('wardrobe.namePlaceholder')} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={80} />
          <SelectField label={t('wardrobe.category')} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">—</option>
            {(['CLOTHES', 'SHOES'] as const).map((k) => (
              <optgroup key={k} label={t(k === 'CLOTHES' ? 'wardrobe.clothes' : 'wardrobe.shoes')}>
                {catalog?.categories.filter((c) => c.kind === k).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
              </optgroup>
            ))}
          </SelectField>
        </>
      )}
      <SelectField label={t('book.service')} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
        <option value="">{t('book.chooseService')}</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {name(s)} — {money(unitPriceFor(s, effectiveCategory))}{s.pricingUnit === 'KG' ? '/kg' : ''}
          </option>
        ))}
      </SelectField>
      <TextField
        label={isKg ? t('book.estimatedKg') : t('wardrobe.quantity')}
        hint={isKg ? t('book.kgHint') : undefined}
        type="number"
        inputMode="decimal"
        step={isKg ? 0.5 : 1}
        min={isKg ? 0.5 : 1}
        value={qty}
        onChange={(e) => setQty(e.target.value)}
      />
      {mode === 'manual' && <Checkbox label={t('book.saveToWardrobe')} checked={save} onChange={setSave} />}
      {err && <p className="field-error" role="alert">{err}</p>}
      <Button type="button" variant="secondary" onClick={add}>{t('book.addItem')}</Button>
    </div>
  );
}

export function BookPage() {
  const { t, money } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const preselect = params.get('wardrobe') ?? '';
  const local = useLocalName();
  const { catalog, error: catErr, reload: catReload } = useCatalog();
  const wardrobe = useLoad<Paged<WardrobeItem>>('/me/wardrobe?pageSize=100');
  const addresses = useLoad<{ items: Address[] }>('/me/addresses');
  const slots = useLoad<{ items: Slot[] }>('/pickup-slots?days=7');

  const [step, setStep] = useState<Step>('items');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [addressId, setAddressId] = useState<string>('');
  const [newAddr, setNewAddr] = useState({ label: 'Home', serviceAreaId: '', landmark: '', street: '', details: '', contactPhone: '' });
  const [slotId, setSlotId] = useState('');
  const [deliveryPref, setDeliveryPref] = useState<'SAME' | 'OTHER' | 'COLLECT'>('SAME');
  const [deliveryAddressId, setDeliveryAddressId] = useState('');
  const [notes, setNotes] = useState('');
  const [quote, setQuote] = useState<Pricing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<OrderDetail | null>(null);
  const idemKey = useRef<string>(newKey());

  const saved = addresses.data?.items ?? [];
  useEffect(() => {
    if (saved.length && !addressId) setAddressId(saved[0].id);
    if (addresses.data && !saved.length) setAddressId('new');
  }, [addresses.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const payload = useMemo(() => {
    const p: any = {
      items: items.map(({ key: _k, ...rest }) => (rest.wardrobeItemId ? { wardrobeItemId: rest.wardrobeItemId, quantity: rest.quantity, serviceId: rest.serviceId } : { name: rest.name, categoryId: rest.categoryId, quantity: rest.quantity, serviceId: rest.serviceId, saveToWardrobe: !!rest.saveToWardrobe })),
      pickupSlotId: slotId,
      deliveryPreference: deliveryPref === 'COLLECT' ? 'COLLECT_AT_SHOP' : 'DELIVER_TO_ADDRESS',
      notes,
    };
    if (addressId === 'new') p.pickupAddress = { ...newAddr, contactPhone: newAddr.contactPhone || null };
    else p.pickupAddressId = addressId;
    if (deliveryPref === 'OTHER' && deliveryAddressId) p.deliveryAddressId = deliveryAddressId;
    return p;
  }, [items, slotId, deliveryPref, notes, addressId, newAddr, deliveryAddressId]);

  // Any change after a failed/finished attempt gets a fresh idempotency key.
  useEffect(() => {
    idemKey.current = newKey();
  }, [payload]);

  useEffect(() => {
    if (step !== 'review') return;
    setQuote(null);
    setError(null);
    post<{ pricing: Pricing }>('/bookings/quote', payload).then((r) => setQuote(r.pricing), setError);
  }, [step, payload]);

  if (catErr) return <ErrorBox error={catErr} onRetry={catReload} />;
  if (!catalog) return <Loading />;

  if (done) {
    return (
      <div className="stack done">
        <svg className="done-check" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="46" />
          <path d="M30 52 L44 65 L71 37" />
        </svg>
        <h1>{t('book.doneTitle')}</h1>
        <p className="lede">{t('book.done')}</p>
        <p><span className="done-ref">{done.reference}</span></p>
        <p className="muted">{t('book.doneBody', { ref: done.reference })}</p>
        <Link className="btn btn-primary btn-block" to={`/orders/${done.id}`}>{t('book.viewOrder')}</Link>
      </div>
    );
  }

  const canNext =
    step === 'items' ? items.length > 0 :
    step === 'pickup' ? !!slotId && (addressId === 'new' ? !!newAddr.serviceAreaId && newAddr.landmark.trim().length >= 2 : !!addressId) :
    step === 'delivery' ? deliveryPref !== 'OTHER' || !!deliveryAddressId : true;
  const idx = STEPS.indexOf(step);
  const area = catalog.areas.find((a) => a.id === newAddr.serviceAreaId);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ order: OrderDetail }>('/bookings', payload, idemKey.current);
      setDone(r.order);
      toast(t('book.done'));
    } catch (e) {
      setError(e);
      slots.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageTitle back={idx > 0 ? () => setStep(STEPS[idx - 1]) : () => nav(-1)}>{t('book.title')}</PageTitle>
      <ol className="steps" aria-label={t('book.title')}>
        {STEPS.map((s, i) => (
          <li key={s} className={i === idx ? 'on' : i < idx ? 'past' : ''} aria-current={i === idx ? 'step' : undefined}>{t(`book.step.${s}` as any)}</li>
        ))}
      </ol>

      {step === 'items' && (
        <>
          {items.length > 0 && (
            <section>
              <h2>{t('book.items')}</h2>
              <ul className="draft">
                {items.map((d) => {
                  const s = catalog.services.find((x) => x.id === d.serviceId)!;
                  return (
                    <li key={d.key}>
                      <span><strong>{d.name}</strong> <span className="muted small">{local(s)} · {d.quantity}{s.pricingUnit === 'KG' ? ' kg' : '×'}</span></span>
                      <button type="button" className="btn btn-quiet danger-text" onClick={() => setItems(items.filter((x) => x.key !== d.key))}>{t('book.remove')}</button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {wardrobe.data ? <ItemAdder services={catalog.services} wardrobe={wardrobe.data.items} initialWid={wardrobe.data.items.some((x) => x.id === preselect) ? preselect : ''} onAdd={(d) => setItems([...items, d])} /> : <Loading block rows={1} />}
          {items.length === 0 && <p className="muted">{t('book.noItems')}</p>}
        </>
      )}

      {step === 'pickup' && (
        <>
          <fieldset className="choices">
            <legend>{t('book.address')}</legend>
            {saved.map((a) => (
              <label key={a.id} className="choice">
                <input type="radio" name="addr" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                <span><strong>{a.label}</strong> <span className="muted small">{a.serviceAreaName} · {a.landmark}</span></span>
              </label>
            ))}
            <label className="choice">
              <input type="radio" name="addr" checked={addressId === 'new'} onChange={() => setAddressId('new')} />
              <span>{t('book.newAddress')}</span>
            </label>
          </fieldset>
          {addressId === 'new' && (
            <div className="stack inset">
              <SelectField label={t('book.area')} value={newAddr.serviceAreaId} onChange={(e) => setNewAddr({ ...newAddr, serviceAreaId: e.target.value })} required>
                <option value="">{t('book.chooseArea')}</option>
                {['Gasabo', 'Kicukiro', 'Nyarugenge'].map((d) => (
                  <optgroup key={d} label={d}>
                    {catalog.areas.filter((a) => a.district === d).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </optgroup>
                ))}
              </SelectField>
              {area && area.landmarks.length > 0 && <p className="hint">{area.landmarks.join(', ')} · {t('book.pickupFee')}: {money(area.pickupFee)}</p>}
              <TextField label={t('book.landmark')} hint={t('book.landmarkHint')} value={newAddr.landmark} onChange={(e) => setNewAddr({ ...newAddr, landmark: e.target.value })} required maxLength={160} />
              <TextField label={t('book.street')} optional value={newAddr.street} onChange={(e) => setNewAddr({ ...newAddr, street: e.target.value })} maxLength={120} />
              <TextField label={t('book.details')} hint={t('book.detailsHint')} optional value={newAddr.details} onChange={(e) => setNewAddr({ ...newAddr, details: e.target.value })} maxLength={300} />
              <TextField label={t('book.contactPhone')} optional type="tel" inputMode="tel" value={newAddr.contactPhone} onChange={(e) => setNewAddr({ ...newAddr, contactPhone: e.target.value })} />
            </div>
          )}
          {slots.loading && !slots.data ? <Loading /> : <ErrorBox error={slots.error} onRetry={slots.reload} />}
          {slots.data && <SlotPicker value={slotId} onChange={setSlotId} slots={slots.data.items} />}
        </>
      )}

      {step === 'delivery' && (
        <fieldset className="choices">
          <legend>{t('book.deliveryPref')}</legend>
          <label className="choice"><input type="radio" name="del" checked={deliveryPref === 'SAME'} onChange={() => setDeliveryPref('SAME')} /><span>{t('book.deliverSame')}</span></label>
          {saved.length > 0 && (
            <label className="choice"><input type="radio" name="del" checked={deliveryPref === 'OTHER'} onChange={() => setDeliveryPref('OTHER')} /><span>{t('book.deliverOther')}</span></label>
          )}
          {deliveryPref === 'OTHER' && (
            <SelectField label={t('order.return')} value={deliveryAddressId} onChange={(e) => setDeliveryAddressId(e.target.value)}>
              <option value="">—</option>
              {saved.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.serviceAreaName}</option>)}
            </SelectField>
          )}
          <label className="choice"><input type="radio" name="del" checked={deliveryPref === 'COLLECT'} onChange={() => setDeliveryPref('COLLECT')} /><span>{t('book.collect')}</span></label>
        </fieldset>
      )}

      {step === 'review' && (
        <>
          <section>
            <h2>{t('book.estimate')}</h2>
            {quote ? <PriceBreakdown pricing={quote} /> : !error && <Loading />}
            <p className="hint">{t('book.estimateNote')}</p>
          </section>
          <TextArea label={t('book.notes')} optional value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </>
      )}

      <ErrorBox error={error} />
      {step !== 'review' ? (
        <Button className="btn-block" disabled={!canNext} onClick={() => setStep(STEPS[idx + 1])}>{t('common.next')}</Button>
      ) : (
        <Button className="btn-block" busy={busy} disabled={!quote} onClick={confirm}>
          {busy ? t('book.confirming') : quote ? `${t('book.confirm')} · ${money(quote.total)}` : t('book.confirm')}
        </Button>
      )}
    </div>
  );
}
