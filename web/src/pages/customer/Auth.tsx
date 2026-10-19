import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, post } from '../../api';
import { useAuth } from '../../auth';
import { useI18n } from '../../i18n';
import type { User } from '../../types';
import { PlainLayout } from '../../components/Layout';
import { Button, Checkbox, ErrorBox, Notice, TextField } from '../../components/ui';
import { SupportLinks } from './Home';

function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details as any[]) out[d.path] = d.message;
  return out;
}

function homeFor(u: User) {
  return u.role === 'RIDER' ? '/rider' : u.role === 'STAFF' || u.role === 'ADMIN' ? '/staff' : '/';
}

export function LoginPage() {
  const { t } = useI18n();
  const { setUser } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: User }>('/auth/login', { identifier, password, keepMeLoggedIn: keep });
      setUser(r.user);
      nav(loc.state?.from && r.user.role === 'CUSTOMER' ? loc.state.from : homeFor(r.user), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlainLayout>
      <h1>{t('auth.signIn')}</h1>
      <form onSubmit={submit} className="stack" noValidate>
        <TextField label={t('auth.identifier')} hint={t('auth.identifierHint')} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" inputMode="email" required autoCapitalize="none" spellCheck={false} />
        <TextField label={t('auth.password')} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <Checkbox label={t('auth.showPassword')} checked={show} onChange={setShow} />
        <Checkbox label={t('auth.keepMe')} hint={t('auth.keepMeHint')} checked={keep} onChange={setKeep} name="keepMeLoggedIn" />
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="btn-block">{t('auth.signIn')}</Button>
      </form>
      <p className="center-links">
        <Link to="/forgot-password">{t('auth.forgot')}</Link>
      </p>
      <p className="center-links">
        {t('auth.noAccount')} <Link to="/register">{t('auth.register')}</Link>
      </p>
    </PlainLayout>
  );
}

export function RegisterPage() {
  const { t, lang } = useI18n();
  const { setUser } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<'phone' | 'email'>('phone');
  const [fullName, setFullName] = useState('');
  const [contact, setContact] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fe = fieldErrors(error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: User }>('/auth/register', {
        fullName,
        [mode]: contact,
        password,
        preferredLanguage: lang,
        keepMeLoggedIn: keep,
      });
      setUser(r.user);
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PlainLayout>
      <h1>{t('auth.register')}</h1>
      <p className="lede">{t('auth.registerIntro')}</p>
      <form onSubmit={submit} className="stack" noValidate>
        <TextField label={t('auth.fullName')} value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required error={fe.fullName} />
        <div className="segmented" role="radiogroup" aria-label={`${t('auth.phone')} / ${t('auth.email')}`}>
          <button type="button" role="radio" aria-checked={mode === 'phone'} className={mode === 'phone' ? 'on' : ''} onClick={() => { setMode('phone'); setContact(''); }}>{t('auth.usePhone')}</button>
          <button type="button" role="radio" aria-checked={mode === 'email'} className={mode === 'email' ? 'on' : ''} onClick={() => { setMode('email'); setContact(''); }}>{t('auth.useEmail')}</button>
        </div>
        {mode === 'phone' ? (
          <TextField key="phone" label={t('auth.phone')} hint="078 123 4567" type="tel" inputMode="tel" autoComplete="tel" value={contact} onChange={(e) => setContact(e.target.value)} required error={fe.phone} />
        ) : (
          <TextField key="email" label={t('auth.email')} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" value={contact} onChange={(e) => setContact(e.target.value)} required error={fe.email} />
        )}
        <TextField label={t('auth.password')} hint={t('auth.passwordHint')} type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} error={fe.password} />
        <Checkbox label={t('auth.showPassword')} checked={show} onChange={setShow} />
        <Checkbox label={t('auth.keepMe')} hint={t('auth.keepMeHint')} checked={keep} onChange={setKeep} />
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="btn-block">{t('auth.register')}</Button>
      </form>
      <p className="center-links">
        {t('auth.haveAccount')} <Link to="/login">{t('auth.signIn')}</Link>
      </p>
    </PlainLayout>
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
          <TextField label={t('auth.newPassword')} hint={t('auth.passwordHint')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <ErrorBox error={error} />
          <Button type="submit" busy={busy} className="btn-block">{t('auth.setPassword')}</Button>
        </form>
      )}
    </PlainLayout>
  );
}
