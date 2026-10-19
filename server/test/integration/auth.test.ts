import { beforeAll, describe, expect, it } from 'vitest';
import { one, pool } from '../../src/db.js';
import { email } from '../../src/providers/email.js';
import { client, resetDb } from '../helpers.js';

beforeAll(resetDb);

const cookieOf = (res: any) => (res.headers['set-cookie'] as string[] | undefined)?.find((c) => c.startsWith('ld_sid=')) ?? '';

describe('registration & login', () => {
  it('registers with email + password (no OTP) and is signed in', async () => {
    const c = client();
    const r = await c.post('/api/v1/auth/register', { fullName: 'Aline', email: 'Aline@Example.com', password: 'goodpassword' });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe('aline@example.com');
    expect(r.body.user).not.toHaveProperty('password_hash');
    expect((await c.get('/api/v1/me')).status).toBe(200);
  });

  it('registers with phone + password and normalizes the number', async () => {
    const r = await client().post('/api/v1/auth/register', { fullName: 'Eric', phone: '0722 000 111', password: 'goodpassword' });
    expect(r.status).toBe(201);
    expect(r.body.user.phone).toBe('+250722000111');
  });

  it('prevents duplicates across formats and case', async () => {
    expect((await client().post('/api/v1/auth/register', { fullName: 'Xa', email: 'ALINE@example.com', password: 'goodpassword' })).status).toBe(409);
    expect((await client().post('/api/v1/auth/register', { fullName: 'Xa', phone: '+250722000111', password: 'goodpassword' })).status).toBe(409);
  });

  it('validates inputs', async () => {
    expect((await client().post('/api/v1/auth/register', { fullName: 'X', password: 'goodpassword' })).status).toBe(400);
    expect((await client().post('/api/v1/auth/register', { fullName: 'X', phone: '123', password: 'goodpassword' })).status).toBe(400);
    expect((await client().post('/api/v1/auth/register', { fullName: 'X', email: 'z@z.co', password: 'short' })).status).toBe(400);
  });

  it('stores an argon2id hash, never the password', async () => {
    const u = await one(pool, `SELECT password_hash FROM users WHERE email = 'aline@example.com'`);
    expect(u.password_hash).toMatch(/^\$argon2id\$/);
    expect(u.password_hash).not.toContain('goodpassword');
  });

  it('logs in with email or phone, with a generic error otherwise', async () => {
    expect((await client().post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'goodpassword' })).status).toBe(200);
    expect((await client().post('/api/v1/auth/login', { identifier: '0722000111', password: 'goodpassword' })).status).toBe(200);
    const wrong = await client().post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'badpassword' });
    const missing = await client().post('/api/v1/auth/login', { identifier: 'nobody@example.com', password: 'badpassword' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body).toEqual(missing.body); // no account enumeration
  });

  it('"Keep me logged in" sets a persistent HttpOnly SameSite cookie; otherwise a session cookie', async () => {
    const keep = cookieOf(await client().post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'goodpassword', keepMeLoggedIn: true }));
    const nokeep = cookieOf(await client().post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'goodpassword', keepMeLoggedIn: false }));
    for (const c of [keep, nokeep]) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=Lax/i);
    }
    expect(keep).toMatch(/Max-Age=2592000/); // 30 days
    expect(nokeep).not.toMatch(/Max-Age|Expires/i);
    const s = await one(pool, `SELECT persistent, absolute_expires_at - created_at AS life FROM sessions ORDER BY created_at DESC LIMIT 1`);
    expect(s.persistent).toBe(false);
  });

  it('logout invalidates the session server-side (a stolen cookie stops working)', async () => {
    const c = client();
    const r = await c.post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'goodpassword' });
    const raw = cookieOf(r).split(';')[0];
    expect((await c.post('/api/v1/auth/logout')).status).toBe(204);
    const replay = await client().agent.get('/api/v1/me').set('Cookie', raw);
    expect(replay.status).toBe(401);
  });

  it('rejects state-changing requests without the CSRF header or from a foreign origin', async () => {
    const c = client();
    expect((await c.agent.post('/api/v1/auth/login').send({ identifier: 'a@b.co', password: 'x' })).status).toBe(403);
    expect((await c.agent.post('/api/v1/auth/login').set('X-Requested-With', 'LaundryDash').set('Origin', 'https://evil.example').send({ identifier: 'a@b.co', password: 'x' })).status).toBe(403);
  });

  it('marks API responses no-store', async () => {
    const r = await client().get('/api/v1/config');
    expect(r.headers['cache-control']).toContain('no-store');
  });
});

describe('password reset', () => {
  const outbox = () => (email as any).outbox as { to: string; text: string }[];

  it('responds identically for existing and unknown emails', async () => {
    const a = await client().post('/api/v1/auth/password-reset/request', { email: 'aline@example.com' });
    const b = await client().post('/api/v1/auth/password-reset/request', { email: 'ghost@example.com' });
    expect(a.status).toBe(202);
    expect(a.body).toEqual(b.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(outbox().filter((m) => m.to === 'ghost@example.com')).toHaveLength(0);
  });

  it('resets with a single-use token, then signs out other sessions', async () => {
    const other = client();
    await other.post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'goodpassword' });
    outbox().length = 0;
    await client().post('/api/v1/auth/password-reset/request', { email: 'aline@example.com' });
    await new Promise((r) => setTimeout(r, 50));
    const msg = outbox().find((m) => m.to === 'aline@example.com')!;
    const token = msg.text.match(/#token=([A-Za-z0-9_-]+)/)![1];
    const tok = await one(pool, 'SELECT token_hash FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1');
    expect(tok.token_hash).not.toBe(token); // stored hashed

    expect((await client().post('/api/v1/auth/password-reset/confirm', { token, password: 'brandnewpass' })).status).toBe(200);
    expect((await client().post('/api/v1/auth/password-reset/confirm', { token, password: 'anotherpass1' })).status).toBe(400); // single use
    expect((await other.get('/api/v1/me')).status).toBe(401);
    expect((await client().post('/api/v1/auth/login', { identifier: 'aline@example.com', password: 'brandnewpass' })).status).toBe(200);
  });

  it('rejects expired tokens', async () => {
    await client().post('/api/v1/auth/password-reset/request', { email: 'aline@example.com' });
    await new Promise((r) => setTimeout(r, 50));
    const token = outbox().at(-1)!.text.match(/#token=([A-Za-z0-9_-]+)/)![1];
    await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
    expect((await client().post('/api/v1/auth/password-reset/confirm', { token, password: 'brandnewpass2' })).status).toBe(400);
  });
});

describe('rate limiting', () => {
  it('locks out repeated failed logins for one identifier with 429', async () => {
    process.env.ENABLE_RATE_LIMIT_IN_TEST = 'true';
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await client().post('/api/v1/auth/login', { identifier: 'victim@example.com', password: 'guess' + i })).status);
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
      // A different identifier from the same IP is not locked out by that
      expect((await client().post('/api/v1/auth/login', { identifier: 'other@example.com', password: 'x' })).status).toBe(401);
    } finally {
      delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
    }
  });
});
