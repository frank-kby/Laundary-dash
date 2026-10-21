import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { useI18n } from '../i18n';

const startedAt = Date.now();
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();

/**
 * Keeps installed copies of the app current.
 * - Checks for a new version on open, whenever the app comes back to the foreground, and every 30 minutes.
 * - If a new version arrives while the app is just opening (or is in the background), it switches immediately.
 * - If someone is in the middle of using it, a small banner offers "Update" so a half-filled form is never lost.
 */
export function startUpdates() {
  if (!('serviceWorker' in navigator)) return;
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      if (Date.now() - startedAt < 8000 || document.visibilityState === 'hidden') void applyUpdate?.(true);
      else listeners.forEach((l) => l());
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (navigator.onLine) reg.update().catch(() => undefined);
      };
      window.setInterval(check, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });
}

export function UpdateBanner() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  if (!ready) return null;
  return (
    <div className="update-banner" role="status">
      <span>{t('update.ready')}</span>
      <button type="button" className="btn btn-sun" onClick={() => void applyUpdate?.(true)}>{t('update.button')}</button>
    </div>
  );
}
