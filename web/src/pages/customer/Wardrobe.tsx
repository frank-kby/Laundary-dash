import { useState, type FormEvent } from 'react';
import { api, del, patch, post } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useLocalName } from '../../catalog';
import { useI18n } from '../../i18n';
import type { Paged, WardrobeItem } from '../../types';
import { PageTitle } from '../../components/Layout';
import { Button, ErrorBox, Loading, Notice, SelectField, Sheet, TextArea, TextField, useLoad } from '../../components/ui';

/** Downscale + re-encode on the device: smaller uploads on mobile data, and strips EXIF (incl. GPS). */
export async function shrinkImage(file: File, max = 1280): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.8));
}

export function WardrobeForm({ item, onDone, onCancel }: { item?: WardrobeItem; onDone: (w: WardrobeItem) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { config } = useAuth();
  const { catalog } = useCatalog();
  const name = useLocalName();
  const [f, setF] = useState({ name: item?.name ?? '', categoryId: item?.categoryId ?? '', color: item?.color ?? '', quantity: String(item?.quantity ?? 1), careNotes: item?.careNotes ?? '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const photosOn = !!config?.features.photos;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, quantity: Number(f.quantity) };
      let w: WardrobeItem = item ? (await patch<{ item: WardrobeItem }>(`/me/wardrobe/${item.id}`, body)).item : (await post<{ item: WardrobeItem }>('/me/wardrobe', body)).item;
      if (photo && photosOn) {
        const form = new FormData();
        form.append('photo', await shrinkImage(photo), 'photo.jpg');
        w = (await api<{ item: WardrobeItem }>('PUT', `/me/wardrobe/${w.id}/photo`, undefined, { form })).item;
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
      <TextField label={t('wardrobe.name')} placeholder={t('wardrobe.namePlaceholder')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} />
      <SelectField label={t('wardrobe.category')} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} required>
        <option value="">—</option>
        {(['CLOTHES', 'SHOES'] as const).map((k) => (
          <optgroup key={k} label={t(k === 'CLOTHES' ? 'wardrobe.clothes' : 'wardrobe.shoes')}>
            {catalog?.categories.filter((c) => c.kind === k).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
          </optgroup>
        ))}
      </SelectField>
      <div className="row-2">
        <TextField label={t('wardrobe.color')} optional value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} maxLength={40} />
        <TextField label={t('wardrobe.quantity')} type="number" inputMode="numeric" min={1} max={100} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
      </div>
      <TextArea label={t('wardrobe.care')} optional placeholder={t('wardrobe.carePlaceholder')} value={f.careNotes} onChange={(e) => setF({ ...f, careNotes: e.target.value })} maxLength={300} />
      {photosOn ? (
        <TextField label={item?.hasPhoto ? t('wardrobe.changePhoto') : t('wardrobe.addPhoto')} optional type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
      ) : (
        <p className="hint">{t('wardrobe.photoOff')}</p>
      )}
      <ErrorBox error={error} />
      <div className="actions">
        <Button type="button" variant="quiet" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" busy={busy}>{busy && photo ? t('wardrobe.photoUploading') : t('common.save')}</Button>
      </div>
    </form>
  );
}

export function WardrobePage() {
  const { t } = useI18n();
  const name = useLocalName();
  const { catalog } = useCatalog();
  const [kind, setKind] = useState<'' | 'CLOTHES' | 'SHOES'>('');
  const [pageSize, setPageSize] = useState(20);
  const list = useLoad<Paged<WardrobeItem>>(`/me/wardrobe?pageSize=${pageSize}${kind ? `&kind=${kind}` : ''}`);
  const [editing, setEditing] = useState<WardrobeItem | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const remove = async (w: WardrobeItem) => {
    if (!confirm(t('wardrobe.deleteConfirm', { name: w.name }))) return;
    setError(null);
    try {
      await del(`/me/wardrobe/${w.id}`);
      list.reload();
    } catch (e) {
      setError(e);
    }
  };
  const cat = (id: string) => catalog?.categories.find((c) => c.id === id);

  return (
    <div className="stack">
      <PageTitle>{t('wardrobe.title')}</PageTitle>
      <p className="muted">{t('wardrobe.intro')}</p>
      <div className="toolbar">
        <div className="segmented" role="tablist">
          {([['', 'wardrobe.all'], ['CLOTHES', 'wardrobe.clothes'], ['SHOES', 'wardrobe.shoes']] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t(label)}</button>
          ))}
        </div>
        <Button onClick={() => setEditing('new')}>{t('wardrobe.add')}</Button>
      </div>
      <ErrorBox error={error} />
      {list.loading && !list.data ? <Loading /> : <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data?.items.length === 0 && <Notice>{t('wardrobe.empty')}</Notice>}
      <ul className="wardrobe">
        {list.data?.items.map((w) => (
          <li key={w.id} className="wardrobe-item">
            {w.photoUrl ? <img src={w.photoUrl} alt="" loading="lazy" width={64} height={64} /> : <span className={`thumb thumb-${w.kind.toLowerCase()}`} aria-hidden="true" />}
            <div className="wardrobe-text">
              <strong>{w.name}</strong>
              <span className="muted small">
                {[cat(w.categoryId) && name(cat(w.categoryId)!), w.color, `× ${w.quantity}`].filter(Boolean).join(', ')}
              </span>
              {w.careNotes && <span className="small">{w.careNotes}</span>}
            </div>
            <div className="wardrobe-actions">
              <button className="btn btn-quiet" onClick={() => setEditing(w)} aria-label={`${t('common.edit')} ${w.name}`}>{t('common.edit')}</button>
              <button className="btn btn-quiet danger-text" onClick={() => remove(w)} aria-label={`${t('common.delete')} ${w.name}`}>{t('common.delete')}</button>
            </div>
          </li>
        ))}
      </ul>
      {list.data && list.data.total > list.data.items.length && (
        <Button variant="secondary" onClick={() => setPageSize((n) => n + 20)}>{t('common.loadMore')}</Button>
      )}
      {editing && (
        <Sheet title={editing === 'new' ? t('wardrobe.newTitle') : t('wardrobe.editTitle')} onClose={() => setEditing(null)}>
          <WardrobeForm item={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); list.reload(); }} />
        </Sheet>
      )}
    </div>
  );
}
