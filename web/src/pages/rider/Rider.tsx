import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../../api';
import { useAuth } from '../../auth';
import { useI18n } from '../../i18n';
import { Brand, LangSwitch, OfflineBanner } from '../../components/Layout';
import { Badge, Button, ErrorBox, Loading, Notice, SelectField, TextField, useLoad } from '../../components/ui';

interface Task {
  id: string; type: 'PICKUP' | 'DELIVERY'; status: string; orderReference: string; windowStart: string | null; windowEnd: string | null;
  instructions: string; customerName: string; contactPhone: string | null; itemCount: number; customerNotes: string; failureReason: string | null;
  address: { area: string; street: string; landmark: string; details: string } | null;
}
const REASONS = ['CUSTOMER_UNREACHABLE', 'CUSTOMER_ABSENT', 'ADDRESS_NOT_FOUND', 'CUSTOMER_REFUSED', 'ITEMS_NOT_READY', 'OTHER'] as const;

function TaskCard({ task, onChange }: { task: Task; onChange: () => void }) {
  const { t, slotLabel } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [count, setCount] = useState('');
  const send = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/rider/tasks/${task.id}/events`, body);
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const open = task.status === 'ASSIGNED' || task.status === 'EN_ROUTE';
  return (
    <li className="task">
      <div className="row-between">
        <Badge tone={task.type === 'PICKUP' ? 'info' : 'ok'}>{t(`rider.${task.type}` as const)}</Badge>
        <span className="muted small">{task.orderReference}</span>
      </div>
      <h2>{task.customerName}</h2>
      {task.windowStart && task.windowEnd && <p><strong>{slotLabel(task.windowStart, task.windowEnd)}</strong></p>}
      {task.address && (
        <p>
          {task.address.area} — {task.address.landmark}
          {task.address.street && <span className="block small">{task.address.street}</span>}
          {task.address.details && <span className="block small">{task.address.details}</span>}
        </p>
      )}
      <p className="small">{t('rider.items', { n: task.itemCount })}{task.customerNotes && ` · ${task.customerNotes}`}</p>
      {task.instructions && <Notice>{task.instructions}</Notice>}
      <p className="small"><Badge>{t(`rider.status.${task.status}` as any)}</Badge>{task.failureReason && ` ${t(`rider.reason.${task.failureReason}` as any)}`}</p>
      {open && (
        <div className="stack">
          {task.contactPhone && <a className="btn btn-secondary" href={`tel:${task.contactPhone}`}>{t('rider.call')} {task.contactPhone}</a>}
          {task.status === 'ASSIGNED' && <Button busy={busy} onClick={() => send({ type: 'START' })}>{t('rider.start')}</Button>}
          {task.type === 'PICKUP' && <TextField label={t('rider.itemCount')} optional type="number" inputMode="numeric" min={0} value={count} onChange={(e) => setCount(e.target.value)} />}
          <Button busy={busy} onClick={() => send({ type: 'COMPLETE', ...(count ? { collectedItemCount: Number(count) } : {}) })}>{t(`rider.complete.${task.type}` as const)}</Button>
          {!failing ? (
            <Button variant="quiet" className="danger-text" onClick={() => setFailing(true)}>{t('rider.fail')}</Button>
          ) : (
            <div className="stack inset">
              <SelectField label={t('rider.failReason')} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">—</option>
                {REASONS.map((r) => <option key={r} value={r}>{t(`rider.reason.${r}` as const)}</option>)}
              </SelectField>
              <TextField label={t('rider.note')} optional value={note} onChange={(e) => setNote(e.target.value)} />
              <Button variant="danger" busy={busy} disabled={!reason} onClick={() => send({ type: 'FAIL', failureReason: reason, note })}>{t('rider.confirmFail')}</Button>
            </div>
          )}
        </div>
      )}
      <ErrorBox error={error} />
    </li>
  );
}

export function RiderPage() {
  const { t } = useI18n();
  const { logout } = useAuth();
  const nav = useNavigate();
  const [scope, setScope] = useState<'active' | 'done'>('active');
  const tasks = useLoad<{ items: Task[] }>(`/rider/tasks?scope=${scope}`);
  return (
    <div className="shell shell-plain">
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          <LangSwitch />
          <button className="btn btn-quiet" onClick={async () => { await logout(); nav('/login'); }}>{t('auth.signOut')}</button>
        </div>
      </header>
      <OfflineBanner />
      <main className="page stack">
        <h1>{t('rider.title')}</h1>
        <div className="segmented">
          <button className={scope === 'active' ? 'on' : ''} aria-pressed={scope === 'active'} onClick={() => setScope('active')}>{t('bookings.active')}</button>
          <button className={scope === 'done' ? 'on' : ''} aria-pressed={scope === 'done'} onClick={() => setScope('done')}>{t('rider.done')}</button>
        </div>
        {tasks.loading && !tasks.data ? <Loading /> : <ErrorBox error={tasks.error} onRetry={tasks.reload} />}
        {tasks.data?.items.length === 0 && <Notice>{t('rider.empty')}</Notice>}
        <ul className="tasks">{tasks.data?.items.map((task) => <TaskCard key={task.id} task={task} onChange={tasks.reload} />)}</ul>
        <Button variant="secondary" onClick={tasks.reload}>{t('common.retry')}</Button>
      </main>
    </div>
  );
}
