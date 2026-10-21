import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, post } from '../../api';
import { useAuth } from '../../auth';
import { useI18n } from '../../i18n';
import { BUSINESS_TYPES, type AccountType, type Gender, type User } from '../../types';
import { LangSwitch, Logo, OfflineBanner, PlainLayout } from '../../components/Layout';
import { Button, Checkbox, ErrorBox, Notice, SelectField, Sheet, TextField } from '../../components/ui';
import { SupportLinks } from './Home';
import { isStandalone } from '../../components/InstallHint';

function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details as any[]) out[d.path] = d.message;
  return out;
}

export function homeFor(u: User) {
  return u.role === 'RIDER' ? '/rider' : u.role === 'STAFF' || u.role === 'ADMIN' ? '/staff' : '/';
}

function PasswordField({ label, hint, value, onChange, autoComplete, error }: { label: string; hint?: string; value: string; onChange: (v: string) => void; autoComplete: string; error?: string }) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={`pw-${autoComplete}`}>{label}</label>
      <div className="pw-wrap">
        <input id={`pw-${autoComplete}`} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required minLength={autoComplete === 'new-password' ? 8 : undefined} aria-invalid={!!error} />
        <button type="button" className="pw-toggle" aria-label={t('auth.showPassword')} aria-pressed={show} onClick={() => setShow((s) => !s)}>
          {show ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3.2 3.8M6.2 7.6A17 17 0 0 0 3 12s4 6 9 6a9.6 9.6 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
      {hint && !error && <p className="hint">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** Sign-in / create-account form used by the welcome page and by the guest sign-up sheet. */
export function AuthForm({ initialMode = 'register', onAuthed, compact = false }: { initialMode?: 'signin' | 'register'; onAuthed: (u: User) => void; compact?: boolean }) {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState(initialMode);
  const [identifier, setIdentifier] = useState('');
  const [fullName, setFullName] = useState('');
  const [contactMode, setContactMode] = useState<'phone' | 'email'>('phone');
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  // Installed (Home Screen) apps are personal devices and lose browser-session cookies when closed.
  const [keep, setKeep] = useState(isStandalone());
  const [accountType, setAccountType] = useState<AccountType>('PERSONAL');
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fe = fieldErrors(error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === 'signin'
          ? await post<{ user: User }>('/auth/login', { identifier, password, keepMeLoggedIn: keep })
          : await post<{ user: User }>('/auth/register', {
              fullName,
              [contactMode]: contact,
              password,
              preferredLanguage: lang,
              keepMeLoggedIn: keep,
              accountType,
              gender: accountType === 'PERSONAL' ? gender : null,
              businessName: accountType === 'BUSINESS' ? businessName : null,
              businessType: accountType === 'BUSINESS' && businessType ? businessType : null,
            });
      onAuthed(r.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`auth-form${compact ? ' auth-form-compact' : ''}`}>
      <div className="auth-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setError(null); }}>{t('auth.tabRegister')}</button>
        <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'on' : ''} onClick={() => { setMode('signin'); setError(null); }}>{t('auth.tabSignIn')}</button>
        <span className={`auth-tabs-pill${mode === 'signin' ? ' right' : ''}`} aria-hidden="true" />
      </div>

      <form key={mode} onSubmit={submit} className="stack auth-panel" noValidate>
        {mode === 'signin' ? (
          <>
            <TextField label={t('auth.identifier')} hint={t('auth.identifierHint')} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" inputMode="email" required autoCapitalize="none" spellCheck={false} />
            <PasswordField label={t('auth.password')} value={password} onChange={setPassword} autoComplete="current-password" />
          </>
        ) : (
          <>
            <fieldset>
              <legend className="sr-only">{t('auth.accountType')}</legend>
              <div className="type-cards">
                {(['PERSONAL', 'BUSINESS'] as const).map((k) => (
                  <label key={k} className={`type-card${accountType === k ? ' on' : ''}`}>
                    <input type="radio" name="accountType" value={k} checked={accountType === k} onChange={() => setAccountType(k)} />
                    {k === 'PERSONAL' ? (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
                    ) : (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 10h4a1 1 0 0 1 1 1v10M8 8h3M8 12h3M8 16h3M3 21h18" /></svg>
                    )}
                    <strong>{t(k === 'PERSONAL' ? 'auth.personal' : 'auth.business')}</strong>
                    <span>{t(k === 'PERSONAL' ? 'auth.personalHint' : 'auth.businessHint')}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <TextField label={t('auth.fullName')} value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required error={fe.fullName} />
            {accountType === 'BUSINESS' && (
              <div className="reveal stack">
                <TextField label={t('auth.businessName')} value={businessName} onChange={(e) => setBusinessName(e.target.value)} autoComplete="organization" required error={fe.businessName} />
                <SelectField label={t('auth.businessType')} optional value={businessType} onChange={(e) => setBusinessType(e.target.value)}>
                  <option value="">—</option>
                  {BUSINESS_TYPES.map((b) => <option key={b} value={b}>{t(`biz.${b}`)}</option>)}
                </SelectField>
              </div>
            )}
            <div className="segmented seg-small" role="radiogroup" aria-label={`${t('auth.phone')} / ${t('auth.email')}`}>
              <button type="button" role="radio" aria-checked={contactMode === 'phone'} className={contactMode === 'phone' ? 'on' : ''} onClick={() => { setContactMode('phone'); setContact(''); }}>{t('auth.usePhone')}</button>
              <button type="button" role="radio" aria-checked={contactMode === 'email'} className={contactMode === 'email' ? 'on' : ''} onClick={() => { setContactMode('email'); setContact(''); }}>{t('auth.useEmail')}</button>
            </div>
            {contactMode === 'phone' ? (
              <TextField key="phone" label={t('auth.phone')} hint="078 123 4567" type="tel" inputMode="tel" autoComplete="tel" value={contact} onChange={(e) => setContact(e.target.value)} required error={fe.phone} />
            ) : (
              <TextField key="email" label={t('auth.email')} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={contact} onChange={(e) => setContact(e.target.value)} required error={fe.email} />
            )}
            <PasswordField label={t('auth.password')} hint={t('auth.passwordHint')} value={password} onChange={setPassword} autoComplete="new-password" error={fe.password} />
            {accountType === 'PERSONAL' && (
              <fieldset>
                <legend className="label">{t('auth.gender')} <span className="optional">({t('common.optional')})</span></legend>
                <div className="chips chips-wrap" role="radiogroup">
                  {([['FEMALE', 'gender.FEMALE'], ['MALE', 'gender.MALE'], [null, 'gender.ANY']] as const).map(([g, key]) => (
                    <button key={key} type="button" role="radio" aria-checked={gender === g} aria-pressed={gender === g} className="chip" onClick={() => setGender(g)}>{t(key)}</button>
                  ))}
                </div>
                <p className="hint">{t('auth.genderHint')}</p>
              </fieldset>
            )}
          </>
        )}
        <Checkbox label={t('auth.keepMe')} hint={t('auth.keepMeHint')} checked={keep} onChange={setKeep} name="keepMeLoggedIn" />
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="btn-block btn-lg">{mode === 'signin' ? t('auth.signIn') : t('auth.register')}</Button>
        {mode === 'signin' ? (
          <p className="center-links small">
            <Link to="/forgot-password">{t('auth.forgot')}</Link>
          </p>
        ) : (
          <p className="center-links small muted">{t('auth.perks')}</p>
        )}
      </form>
    </div>
  );
}

/** Animated header: a clothesline of garments swaying over rising bubbles. */
function WelcomeHero() {
  const { t } = useI18n();
  return (
    <div className="welcome-hero">
      <div className="bubbles" aria-hidden="true">
        {[
          ['6%', 22, '13s', '0s', '12px'], ['18%', 12, '10s', '-3s', '-8px'], ['33%', 30, '16s', '-8s', '10px'], ['52%', 16, '12s', '-5s', '-14px'],
          ['67%', 26, '14s', '-10s', '8px'], ['82%', 14, '11s', '-2s', '-10px'], ['92%', 34, '17s', '-12s', '14px'],
        ].map(([l, s, d, delay, x], i) => (
          <span key={i} style={{ left: l as string, width: s as number, height: s as number, ['--d' as string]: d, ['--delay' as string]: delay, ['--x' as string]: x }} />
        ))}
      </div>
      <div className="welcome-top">
        <LangSwitch />
      </div>
      <div className="logo-stage">
        <div className="logo-streaks" aria-hidden="true"><span /><span /><span /></div>
        <div className="logo-badge"><Logo height={128} /></div>
      </div>
      <div className="welcome-copy">
        <h1>{t('auth.welcomeTitle')}</h1>
        <p>{t('auth.welcomeBody')}</p>
      </div>
    </div>
  );
}

export function AuthPage({ initialMode }: { initialMode: 'signin' | 'register' }) {
  const { t } = useI18n();
  const { setUser } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  return (
    <div className="welcome">
      <OfflineBanner />
      <WelcomeHero />
      <main className="welcome-card" id="main">
        <AuthForm
          initialMode={initialMode}
          onAuthed={(u) => {
            setUser(u);
            nav(loc.state?.from && u.role === 'CUSTOMER' ? loc.state.from : homeFor(u), { replace: true });
          }}
        />
        <Link to="/" className="btn btn-quiet btn-block guest-link">
          {t('auth.continueGuest')}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </Link>
      </main>
    </div>
  );
}
export const LoginPage = () => <AuthPage initialMode="signin" />;
export const RegisterPage = () => <AuthPage initialMode="register" />;

/** Sign-up sheet shown to guests at the moment an account is needed (confirm booking, save to wardrobe…). */
export function AuthSheet({ title, body, mode = 'register', onClose, onAuthed }: { title: string; body?: string; mode?: 'signin' | 'register'; onClose: () => void; onAuthed: (u: User) => void }) {
  const { setUser } = useAuth();
  return (
    <Sheet title={title} onClose={onClose}>
      {body && <p className="muted">{body}</p>}
      <AuthForm compact initialMode={mode} onAuthed={(u) => { setUser(u); onAuthed(u); }} />
    </Sheet>
  );
}

/** Friendly explainer shown instead of a members-only screen when browsing as a guest. */
export function GuestGate({ title, body, art, onAuthed }: { title: string; body: string; art?: ReactNode; onAuthed?: (u: User) => void }) {
  const { t } = useI18n();
  const [sheet, setSheet] = useState<null | 'register' | 'signin'>(null);
  return (
    <div className="gate">
      <div className="gate-art" aria-hidden="true">
        {art ?? (
          <svg width="120" height="96" viewBox="0 0 120 96"><path d="M6 16 Q60 32 114 16" fill="none" stroke="#13203b" strokeWidth="2" /><path d="M26 24 L36 20 Q42 26 48 20 L58 24 L66 36 L58 42 L56 38 L56 80 L28 80 L28 38 L26 42 L18 36 Z" fill="#9ccbf3" stroke="#1f5fa8" strokeWidth="2" strokeLinejoin="round" /><path d="M76 26 L82 26 Q86 31 90 26 L96 26 L98 42 L110 82 L68 82 L80 42 Z" fill="#f5c443" stroke="#13203b" strokeWidth="2" strokeLinejoin="round" /></svg>
        )}
      </div>
      <h1>{title}</h1>
      <p className="lede">{body}</p>
      <Button className="btn-block btn-lg" onClick={() => setSheet('register')}>{t('gate.create')}</Button>
      <Button variant="secondary" className="btn-block" onClick={() => setSheet('signin')}>{t('gate.signIn')}</Button>
      {sheet && <AuthSheet title={title} mode={sheet} onClose={() => setSheet(null)} onAuthed={(u) => { setSheet(null); onAuthed?.(u); }} />}
    </div>
  );
}

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const { config } = useAuth();
  const [emailV, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const enabled = !!config?.features.emailPasswordReset;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ message: string }>('/auth/password-reset/request', { email: emailV });
      setDone(r.message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlainLayout>
      <h1>{t('auth.resetTitle')}</h1>
      {!enabled ? (
        <Notice tone="warn">{t('auth.emailUnavailable')}</Notice>
      ) : done ? (
        <Notice tone="ok">{done}</Notice>
      ) : (
        <form onSubmit={submit} className="stack" noValidate>
          <p className="lede">{t('auth.resetIntro')}</p>
          <TextField label={t('auth.email')} type="email" autoComplete="email" value={emailV} onChange={(e) => setEmail(e.target.value)} required />
          <ErrorBox error={error} />
          <Button type="submit" busy={busy} className="btn-block">{t('auth.resetSend')}</Button>
        </form>
      )}
      <Notice>{t('auth.resetPhoneOnly')}</Notice>
      <SupportLinks />
      <p className="center-links"><Link to="/login">{t('auth.signIn')}</Link></p>
    </PlainLayout>
  );
}

export function ResetPasswordPage() {
  const { t } = useI18n();
  // Token arrives in the URL fragment, which browsers never send to servers or in Referer headers.
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/password-reset/confirm', { token, password });
      setDone(true);
      history.replaceState(null, '', '/reset-password'); // drop the token from the address bar
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlainLayout>
      <h1>{t('auth.resetTitle')}</h1>
      {done ? (
        <>
          <Notice tone="ok">{t('auth.resetDone')}</Notice>
          <Link className="btn btn-primary btn-block" to="/login">{t('auth.signIn')}</Link>
        </>
      ) : !token ? (
        <Notice tone="warn">{t('auth.resetMissingToken')} <Link to="/forgot-password">{t('auth.resetSend')}</Link></Notice>
      ) : (
        <form onSubmit={submit} className="stack" noValidate>
          <PasswordField label={t('auth.newPassword')} hint={t('auth.passwordHint')} value={password} onChange={setPassword} autoComplete="new-password" />
          <ErrorBox error={error} />
          <Button type="submit" busy={busy} className="btn-block">{t('auth.setPassword')}</Button>
        </form>
      )}
    </PlainLayout>
  );
}
