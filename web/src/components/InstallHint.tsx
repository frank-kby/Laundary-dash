import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const KEY = 'ld.installHintDismissedAt'; // per-device convenience only
const SNOOZE_DAYS = 14;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}
export function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
function snoozed() {
  try {
    const at = Number(localStorage.getItem(KEY) ?? 0);
    return Date.now() - at < SNOOZE_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

/**
 * Suggests installing the app: on iPhone/iPad (where there is no install prompt) it explains Share → Add to Home Screen;
 * on Android/Chrome it offers the browser's own install prompt. Hidden once installed or after "Not now" (for 14 days).
 */
export function InstallHint() {
  const { t } = useI18n();
  const [mode, setMode] = useState<null | 'ios' | 'prompt'>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || snoozed()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode('prompt');
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const timer = isIos() ? window.setTimeout(() => setMode('ios'), 2500) : undefined;
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* storage unavailable: just hide for now */
    }
    setMode(null);
  };

  if (!mode) return null;
  return (
    <div className="install-hint" role="dialog" aria-label="Laundry Dash">
      <img src="/icon-192.png" alt="" width={40} height={40} />
      {mode === 'ios' ? (
        <p>
          {t('install.ios')}{' '}
          <svg className="share-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>
        </p>
      ) : (
        <>
          <p>{t('install.android')}</p>
          <button
            type="button"
            className="btn btn-sun"
            onClick={async () => {
              if (!deferred) return;
              await deferred.prompt();
              await deferred.userChoice.catch(() => null);
              setDeferred(null);
              setMode(null);
            }}
          >
            {t('install.button')}
          </button>
        </>
      )}
      <button type="button" className="btn btn-quiet" onClick={dismiss}>{t('install.dismiss')}</button>
    </div>
  );
}
