import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, del, patch, post } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useLocalName } from '../../catalog';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import type { Paged, WardrobeItem, WardrobeStats } from '../../types';
import { PageTitle } from '../../components/Layout';
import { Button, ColorDot, ErrorBox, isLight, Loading, SelectField, Sheet, Silhouette, silhouetteFor, TextArea, TextField, useLoad, useToast } from '../../components/ui';

/** Preset colours. The name is stored in the language the customer used; the hex drives the swatch. */
export const COLORS: { key: string; hex: string | null }[] = [
  { key: 'white', hex: '#FFFFFF' }, { key: 'black', hex: '#1A1A1A' }, { key: 'grey', hex: '#8A8F98' }, { key: 'navy', hex: '#1F2A4D' },
  { key: 'blue', hex: '#2563C9' }, { key: 'lightblue', hex: '#8EC5F0' }, { key: 'red', hex: '#C62828' }, { key: 'maroon', hex: '#7A1F2B' },
  { key: 'pink', hex: '#F4A6C0' }, { key: 'purple', hex: '#7B4FC9' }, { key: 'green', hex: '#2E7D4F' }, { key: 'olive', hex: '#6B7A3A' },
  { key: 'yellow', hex: '#F5C443' }, { key: 'orange', hex: '#EE7B2A' }, { key: 'brown', hex: '#7A4E2D' }, { key: 'beige', hex: '#D8C3A0' },
  { key: 'multi', hex: null },
];

/**
 * Downscale + re-encode on the device: small uploads on mobile data, strips EXIF (incl. GPS), and turns
 * iPhone HEIC photos into JPEG. ~800 px / quality 0.78 lands around 60–120 KB.
 */
export async function shrinkImage(file: File, max = 800): Promise<Blob> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    source = await new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  const w = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const h = 'naturalHeight' in source ? source.naturalHeight : source.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background instead of black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.78));
}

function ColorPicker({ hex, name, onChange }: { hex: string | null; name: string; onChange: (hex: string | null, name: string) => void }) {
  const { t } = useI18n();
  const presetNames = COLORS.map((c) => t(`color.${c.key}` as MessageKey));
  const selectedPreset = COLORS.findIndex((c, i) => c.hex === hex && presetNames[i] === name);
  const isCustom = !!hex && selectedPreset === -1;
  return (
    <fieldset>
      <legend>{t('wardrobe.color')} <span className="optional">({t('common.optional')})</span></legend>
      <div className="swatches" role="radiogroup" aria-label={t('wardrobe.color')}>
        {COLORS.map((c, i) => {
          const on = selectedPreset === i;
          return (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={presetNames[i]}
              title={presetNames[i]}
              className={`swatch${c.hex ? '' : ' dot-multi'}`}
              style={{ ...(c.hex ? { background: c.hex } : {}), ['--check' as string]: isLight(c.hex) && c.hex ? '#13203b' : '#fff' }}
              onClick={() => (on ? onChange(null, '') : onChange(c.hex, presetNames[i]))}
            />
          );
        })}
        <label className="swatch swatch-custom" aria-checked={isCustom} role="radio" title={t('wardrobe.colorCustom')} style={isCustom ? { background: hex! } : undefined}>
          <span className="sr-only">{t('wardrobe.colorCustom')}</span>
          <input type="color" value={hex ?? '#1f5fa8'} onChange={(e) => onChange(e.target.value.toUpperCase(), name && !COLORS.some((_, i) => presetNames[i] === name) ? name : t('wardrobe.colorCustom'))} />
        </label>
      </div>
      <div className="color-name">
        <ColorDot hex={hex} name={name} size={20} />
        <span>{name || t('wardrobe.colorNone')}</span>
      </div>
      {(isCustom || (name && selectedPreset === -1 && !hex)) && (
        <TextField label={t('wardrobe.color')} value={name} maxLength={40} onChange={(e) => onChange(hex, e.target.value)} />
      )}
    </fieldset>
  );
}

function QtyStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { t } = useI18n();
  return (
    <div>
      <span className="label" id="qty-label">{t('wardrobe.quantity')}</span>
      <div className="stepper" role="group" aria-labelledby="qty-label">
        <button type="button" aria-label={t('wardrobe.qtyLess')} disabled={value <= 1} onClick={() => onChange(value - 1)}>−</button>
        <output aria-live="polite">{value}</output>
        <button type="button" aria-label={t('wardrobe.qtyMore')} disabled={value >= 100} onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

export function WardrobeForm({ item, onDone, onCancel }: { item?: WardrobeItem; onDone: (w: WardrobeItem) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { config } = useAuth();
  const { catalog } = useCatalog();
  const localName = useLocalName();
  const [f, setF] = useState({
    name: item?.name ?? '',
    categoryId: item?.categoryId ?? '',
    color: item?.color ?? '',
    colorHex: item?.colorHex ?? null as string | null,
    quantity: item?.quantity ?? 1,
    value: item?.purchaseValue != null ? String(item.purchaseValue) : '',
    careNotes: item?.careNotes ?? '',
  });
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(item?.photoUrl ?? null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const photosOn = !!config?.features.photos;
  const objectUrl = useRef<string | null>(null);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const small = await shrinkImage(file);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(small);
      setPhoto(small);
      setPreview(objectUrl.current);
      setRemovePhoto(false);
    } catch {
      setError(new Error(t('wardrobe.photoHint')));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: f.name,
        categoryId: f.categoryId,
        color: f.color,
        colorHex: f.colorHex,
        quantity: f.quantity,
        purchaseValue: f.value.trim() === '' ? null : Number(f.value.replace(/[\s,]/g, '')),
        careNotes: f.careNotes,
      };
      let w: WardrobeItem = item
        ? (await patch<{ item: WardrobeItem }>(`/me/wardrobe/${item.id}`, body)).item
        : (await post<{ item: WardrobeItem }>('/me/wardrobe', body)).item;
      if (photo && photosOn) {
        const form = new FormData();
        form.append('photo', photo, 'photo.jpg');
        w = (await api<{ item: WardrobeItem }>('PUT', `/me/wardrobe/${w.id}/photo`, undefined, { form })).item;
      } else if (removePhoto && item?.hasPhoto) {
        await del(`/me/wardrobe/${w.id}/photo`);
        w = { ...w, hasPhoto: false, photoUrl: null };
      }
      onDone(w);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack" noValidate>
      {photosOn ? (
        <div>
          <label className={`photo-pick${preview ? ' has-photo' : ''}`}>
            {preview ? (
              <img src={preview} alt="" />
            ) : (
              <>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                <strong>{t('wardrobe.photoPick')}</strong>
                <span className="small">{t('wardrobe.photoHint')}</span>
              </>
            )}
            <input type="file" accept="image/*" aria-label={t('wardrobe.photoPick')} onChange={(e) => pickPhoto(e.target.files?.[0])} />
          </label>
          {preview && (
            <div className="photo-actions">
              <Button type="button" variant="quiet" className="danger-text" onClick={() => { setPhoto(null); setPreview(null); setRemovePhoto(true); }}>{t('wardrobe.removePhoto')}</Button>
            </div>
          )}
        </div>
      ) : (
        <p className="hint">{t('wardrobe.photoOff')}</p>
      )}

      <TextField label={t('wardrobe.name')} placeholder={t('wardrobe.namePlaceholder')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} />
      <SelectField label={t('wardrobe.category')} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} required>
        <option value="">—</option>
        {(['CLOTHES', 'SHOES'] as const).map((k) => (
          <optgroup key={k} label={t(k === 'CLOTHES' ? 'wardrobe.clothes' : 'wardrobe.shoes')}>
            {catalog?.categories.filter((c) => c.kind === k).map((c) => <option key={c.id} value={c.id}>{localName(c)}</option>)}
          </optgroup>
        ))}
      </SelectField>

      <ColorPicker hex={f.colorHex} name={f.color} onChange={(colorHex, color) => setF({ ...f, colorHex, color })} />

      <div className="row-2">
        <QtyStepper value={f.quantity} onChange={(quantity) => setF({ ...f, quantity })} />
        <div className="field">
          <label htmlFor="wd-value">{t('wardrobe.valueLabel')} <span className="optional">({t('common.optional')})</span></label>
          <div className="input-suffix">
            <input id="wd-value" inputMode="numeric" pattern="[0-9 ,]*" placeholder="15000" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^\d\s,]/g, '') })} aria-describedby="wd-value-hint" />
            <span>RWF</span>
          </div>
        </div>
      </div>
      <p className="hint" id="wd-value-hint">{t('wardrobe.valueHint')}</p>

      <TextArea label={t('wardrobe.care')} optional placeholder={t('wardrobe.carePlaceholder')} value={f.careNotes} onChange={(e) => setF({ ...f, careNotes: e.target.value })} maxLength={300} />
      <ErrorBox error={error} />
      <div className="actions">
        <Button type="button" variant="quiet" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" busy={busy} className="btn-grow">{t('common.save')}</Button>
      </div>
    </form>
  );
}

function ItemDetail({ item, onEdit, onDeleted, onClose }: { item: WardrobeItem; onEdit: () => void; onDeleted: () => void; onClose: () => void }) {
  const { t, money, date } = useI18n();
  const { catalog } = useCatalog();
  const localName = useLocalName();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cat = catalog?.categories.find((c) => c.id === item.categoryId);
  const remove = async () => {
    if (!confirm(t('wardrobe.deleteConfirm', { name: item.name }))) return;
    setBusy(true);
    try {
      await del(`/me/wardrobe/${item.id}`);
      onDeleted();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Sheet title={t('wardrobe.details')} onClose={onClose}>
      <div className="wd-detail-media">
        {item.photoUrl ? <img src={item.photoUrl} alt={item.name} /> : <Silhouette shape={silhouetteFor(item.categoryCode, item.kind)} hex={item.colorHex} />}
      </div>
      <h2 className="num-display" style={{ fontSize: '1.5rem' }}>{item.name}</h2>
      <div className="facts-chips">
        {cat && <span className="fact-chip">{localName(cat)}</span>}
        {(item.color || item.colorHex) && <span className="fact-chip"><ColorDot hex={item.colorHex} name={item.color} />{item.color || item.colorHex}</span>}
        <span className="fact-chip">× {item.quantity}</span>
      </div>
      <div className="row-between">
        <span className="muted">{t('wardrobe.value')}</span>
        <strong className="num-display" style={{ fontSize: '1.3rem' }}>
          {item.purchaseValue != null ? money(item.purchaseValue) : <span className="muted small">{t('wardrobe.noValue')}</span>}
        </strong>
      </div>
      {item.careNotes && <p>{item.careNotes}</p>}
      <div className="history">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span>
          {item.timesCleaned ? t('wardrobe.cleaned', { n: item.timesCleaned }) : t('wardrobe.neverCleaned')}
          {item.lastCleanedAt && <span className="block small">{t('wardrobe.lastCleaned', { date: date(item.lastCleanedAt) })}</span>}
        </span>
      </div>
      <p className="small muted">{t('wardrobe.added', { date: date(item.createdAt) })}</p>
      <ErrorBox error={error} />
      <Button className="btn-block" onClick={() => nav(`/book?wardrobe=${item.id}`)}>{t('wardrobe.bookCleaning')}</Button>
      <div className="actions">
        <Button variant="secondary" onClick={onEdit}>{t('common.edit')}</Button>
        <Button variant="quiet" className="danger-text" busy={busy} onClick={remove}>{t('common.delete')}</Button>
      </div>
    </Sheet>
  );
}

const PlusIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);

export function WardrobePage() {
  const { t, money } = useI18n();
  const toast = useToast();
  const localName = useLocalName();
  const { catalog } = useCatalog();
  const [filter, setFilter] = useState<{ kind: '' | 'CLOTHES' | 'SHOES'; categoryId: string }>({ kind: '', categoryId: '' });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'name' | 'value'>('recent');
  const [pageSize, setPageSize] = useState(24);
  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  const qs = new URLSearchParams({ pageSize: String(pageSize), sort, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.categoryId ? { categoryId: filter.categoryId } : {}), ...(query ? { q: query } : {}) });
  const list = useLoad<Paged<WardrobeItem> & { stats: WardrobeStats }>(`/me/wardrobe?${qs}`);
  const [editing, setEditing] = useState<WardrobeItem | 'new' | null>(null);
  const [viewing, setViewing] = useState<WardrobeItem | null>(null);
  const stats = list.data?.stats;

  const chips = useMemo(() => {
    const cats = catalog?.categories ?? [];
    return [
      { label: t('wardrobe.all'), value: { kind: '' as const, categoryId: '' } },
      { label: t('wardrobe.clothes'), value: { kind: 'CLOTHES' as const, categoryId: '' } },
      { label: t('wardrobe.shoes'), value: { kind: 'SHOES' as const, categoryId: '' } },
      ...cats.map((c) => ({ label: localName(c), value: { kind: '' as const, categoryId: c.id } })),
    ];
  }, [catalog, t, localName]);

  const empty = stats && stats.items === 0;

  return (
    <div className="stack">
      <PageTitle>{t('wardrobe.title')}</PageTitle>
      <p className="muted" style={{ marginTop: '.25rem' }}>{t('wardrobe.subtitle')}</p>

      {stats && !empty && (
        <dl className="wd-summary" aria-label={t('wardrobe.title')}>
          <div>
            <dt>{t('wardrobe.statItems')}</dt>
            <dd>{stats.items}</dd>
          </div>
          <div>
            <dt>{t('wardrobe.statValue')}</dt>
            <dd>{money(stats.totalValue).replace(' RWF', '')}<span style={{ fontSize: '.9rem', fontWeight: 700 }}> RWF</span></dd>
          </div>
          <p className="sub">{t('wardrobe.statSplit', { c: stats.clothes, s: stats.shoes })}, {t('wardrobe.statPieces', { n: stats.pieces })}</p>
        </dl>
      )}

      {!empty && (
        <>
          <div className="wd-tools">
            <div className="search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input type="search" placeholder={t('wardrobe.search')} aria-label={t('wardrobe.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select aria-label={t('wardrobe.sortLabel')} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="recent">{t('wardrobe.sort.recent')}</option>
              <option value="name">{t('wardrobe.sort.name')}</option>
              <option value="value">{t('wardrobe.sort.value')}</option>
            </select>
          </div>
          <div className="chips" role="group" aria-label={t('wardrobe.filter')}>
            {chips.map((c) => {
              const on = filter.kind === c.value.kind && filter.categoryId === c.value.categoryId;
              return <button key={c.label} type="button" className="chip" aria-pressed={on} onClick={() => setFilter(c.value)}>{c.label}</button>;
            })}
          </div>
        </>
      )}

      {list.loading && !list.data ? <Loading rows={2} block /> : <ErrorBox error={list.error} onRetry={list.reload} />}

      {empty && (
        <div className="wd-empty">
          <svg width="96" height="80" viewBox="0 0 120 100" aria-hidden="true">
            <path d="M8 18 Q60 34 112 18" fill="none" stroke="#13203b" strokeWidth="2" />
            <path d="M26 26 L36 22 Q42 28 48 22 L58 26 L66 38 L58 44 L56 40 L56 80 L28 80 L28 40 L26 44 L18 38 Z" fill="#9ccbf3" stroke="#1f5fa8" strokeWidth="2" strokeLinejoin="round" />
            <path d="M74 28 L80 28 Q84 33 88 28 L94 28 L96 44 L108 82 L66 82 L78 44 Z" fill="#f5c443" stroke="#13203b" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <h2>{t('wardrobe.empty')}</h2>
          <Button variant="sun" onClick={() => setEditing('new')}><PlusIcon />{t('wardrobe.add')}</Button>
        </div>
      )}

      {list.data && !empty && list.data.items.length === 0 && <p className="muted">{t('wardrobe.noResults')}</p>}

      <ul className="wd-grid">
        {list.data?.items.map((w) => {
          const cat = catalog?.categories.find((c) => c.id === w.categoryId);
          return (
            <li key={w.id}>
              <button type="button" className="wd-card" onClick={() => setViewing(w)} aria-label={`${w.name}${w.color ? `, ${w.color}` : ''}`}>
                <div className="wd-media">
                  {w.photoUrl ? <img src={w.photoUrl} alt="" loading="lazy" decoding="async" /> : <Silhouette shape={silhouetteFor(w.categoryCode, w.kind)} hex={w.colorHex} />}
                  {w.quantity > 1 && <span className="wd-qty">×{w.quantity}</span>}
                </div>
                <div className="wd-body">
                  <span className="wd-name">{w.name}</span>
                  <span className="wd-meta">
                    {(w.colorHex || w.color) && <ColorDot hex={w.colorHex} name={w.color} size={12} />}
                    <span>{cat ? localName(cat) : ''}</span>
                  </span>
                  {w.purchaseValue != null && <span className="wd-value">{money(w.purchaseValue)}</span>}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {list.data && list.data.total > list.data.items.length && <Button variant="secondary" className="btn-block" onClick={() => setPageSize((n) => n + 24)}>{t('common.loadMore')}</Button>}

      {!empty && (
        <button type="button" className="fab" onClick={() => setEditing('new')}>
          <PlusIcon />
          {t('wardrobe.add')}
        </button>
      )}

      {viewing && (
        <ItemDetail
          item={viewing}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); }}
          onDeleted={() => { setViewing(null); toast(t('wardrobe.deletedToast')); list.reload(); }}
        />
      )}
      {editing && (
        <Sheet title={editing === 'new' ? t('wardrobe.newTitle') : t('wardrobe.editTitle')} onClose={() => setEditing(null)}>
          <WardrobeForm
            item={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(null)}
            onDone={(w) => { setEditing(null); toast(t('wardrobe.savedToast')); list.reload(); if (editing !== 'new') setViewing(w); }}
          />
        </Sheet>
      )}
    </div>
  );
}
