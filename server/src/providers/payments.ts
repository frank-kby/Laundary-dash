import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { timingSafeEqualStr } from '../security.js';

export type ProviderStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED' | 'UNKNOWN';

export interface WebhookInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
}

/**
 * Mobile Money provider adapter. Rule: a webhook only tells us *which* payment to re-check.
 * The authoritative status always comes from fetchStatus() (server-to-provider), never from the webhook body.
 * The customer approves on their own phone (USSD prompt) — this app never sees or stores a PIN.
 */
export interface PaymentProvider {
  readonly name: 'simulator' | 'mtn_momo';
  readonly mode: 'test' | 'live';
  initiate(p: { paymentId: string; amount: number; msisdn: string; note: string }): Promise<{ providerReference: string; status: 'PENDING' | 'FAILED'; reason?: string }>;
  fetchStatus(providerReference: string): Promise<{ status: ProviderStatus; reason?: string }>;
  /** Authenticates the webhook and extracts the provider reference + a dedup id. */
  verifyWebhook(input: WebhookInput): { ok: false } | { ok: true; providerReference: string; eventId: string };
}

// ---------- TEST MODE simulator ----------
/**
 * Behaves like a real asynchronous provider but moves no money. Payments made with it are stored with
 * provider_mode='test' and labelled "TEST MODE" everywhere in the UI.
 * State lives in memory: after a restart, outcomes are UNKNOWN and payments correctly remain PENDING.
 */
export class SimulatorProvider implements PaymentProvider {
  readonly name = 'simulator' as const;
  readonly mode = 'test' as const;
  private txns = new Map<string, ProviderStatus>();

  async initiate(p: { paymentId: string; amount: number; msisdn: string }) {
    const ref = 'SIM-' + crypto.randomUUID();
    // Magic test number: any MSISDN ending in 0000 is declined immediately.
    if (p.msisdn.endsWith('0000')) {
      this.txns.set(ref, 'FAILED');
      return { providerReference: ref, status: 'FAILED' as const, reason: 'Simulated decline' };
    }
    this.txns.set(ref, 'PENDING');
    return { providerReference: ref, status: 'PENDING' as const };
  }
  async fetchStatus(ref: string) {
    return { status: this.txns.get(ref) ?? ('UNKNOWN' as ProviderStatus) };
  }
  /** Test helper: decide the outcome, and produce a signed webhook as a provider would send it. */
  settle(ref: string, outcome: 'SUCCESSFUL' | 'FAILED') {
    if (!this.txns.has(ref)) return null;
    this.txns.set(ref, outcome);
    const body = JSON.stringify({ eventId: 'evt_' + crypto.randomUUID(), reference: ref, status: outcome });
    return { body, headers: signSimulatorWebhook(body) };
  }
  verifyWebhook(input: WebhookInput) {
    const ts = String(input.headers['x-ld-timestamp'] ?? '');
    const sig = String(input.headers['x-ld-signature'] ?? '');
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    if (!ts || !sig || !Number.isFinite(age) || age > 300) return { ok: false as const };
    const expected = hmac(`${ts}.${input.rawBody.toString('utf8')}`);
    if (!timingSafeEqualStr(sig, expected)) return { ok: false as const };
    try {
      const b = JSON.parse(input.rawBody.toString('utf8'));
      if (typeof b.reference !== 'string' || typeof b.eventId !== 'string') return { ok: false as const };
      return { ok: true as const, providerReference: b.reference, eventId: b.eventId };
    } catch {
      return { ok: false as const };
    }
  }
}

const hmac = (s: string) => crypto.createHmac('sha256', config.PAYMENT_WEBHOOK_SECRET).update(s).digest('hex');
export function signSimulatorWebhook(body: string, at = Math.floor(Date.now() / 1000)) {
  return { 'x-ld-timestamp': String(at), 'x-ld-signature': hmac(`${at}.${body}`), 'content-type': 'application/json' };
}

// ---------- MTN MoMo Collections (NOT VERIFIED: no credentials available) ----------
/**
 * Implements the documented Collections "requesttopay" flow. It has NOT been run against the MTN sandbox
 * or production in this project. MTN callbacks are not cryptographically signed, so the callback URL carries
 * a secret token and the status is always re-fetched from MTN before anything changes.
 */
export class MtnMomoProvider implements PaymentProvider {
  readonly name = 'mtn_momo' as const;
  readonly mode = config.MTN_MOMO_TARGET_ENV === 'sandbox' ? ('test' as const) : ('live' as const);
  private token: { value: string; exp: number } | null = null;

  private async accessToken() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${config.MTN_MOMO_API_USER}:${config.MTN_MOMO_API_KEY}`).toString('base64');
    const r = await fetch(`${config.MTN_MOMO_BASE_URL}/collection/token/`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': config.MTN_MOMO_SUBSCRIPTION_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`MoMo token request failed (${r.status})`);
    const j: any = await r.json();
    this.token = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async initiate(p: { paymentId: string; amount: number; msisdn: string; note: string }) {
    const ref = crypto.randomUUID(); // X-Reference-Id
    const callback = `${config.APP_ORIGIN}/api/v1/payments/webhooks/mtn_momo?token=${encodeURIComponent(config.PAYMENT_WEBHOOK_SECRET)}`;
    try {
      const r = await fetch(`${config.MTN_MOMO_BASE_URL}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'X-Reference-Id': ref,
          'X-Target-Environment': config.MTN_MOMO_TARGET_ENV,
          'X-Callback-Url': callback,
          'Ocp-Apim-Subscription-Key': config.MTN_MOMO_SUBSCRIPTION_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: String(p.amount),
          currency: config.MTN_MOMO_CURRENCY,
          externalId: p.paymentId,
          payer: { partyIdType: 'MSISDN', partyId: p.msisdn.replace(/^\+/, '') },
          payerMessage: p.note.slice(0, 160),
          payeeNote: p.note.slice(0, 160),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      // 202 Accepted = request created; anything else is a definite failure to start.
      if (r.status === 202) return { providerReference: ref, status: 'PENDING' as const };
      log.warn('momo_initiate_rejected', { status: r.status });
      return { providerReference: ref, status: 'FAILED' as const, reason: `Provider rejected request (${r.status})` };
    } catch (e) {
      // Network error/timeout: the request MAY have reached MTN. Keep PENDING and verify by polling.
      log.warn('momo_initiate_uncertain', { message: (e as Error).message });
      return { providerReference: ref, status: 'PENDING' as const };
    }
  }

  async fetchStatus(ref: string) {
    try {
      const r = await fetch(`${config.MTN_MOMO_BASE_URL}/collection/v1_0/requesttopay/${encodeURIComponent(ref)}`, {
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'X-Target-Environment': config.MTN_MOMO_TARGET_ENV,
          'Ocp-Apim-Subscription-Key': config.MTN_MOMO_SUBSCRIPTION_KEY,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 404) return { status: 'UNKNOWN' as const };
      if (!r.ok) return { status: 'UNKNOWN' as const };
      const j: any = await r.json();
      const s = String(j.status ?? '').toUpperCase();
      if (s === 'SUCCESSFUL') return { status: 'SUCCESSFUL' as const };
      if (s === 'FAILED' || s === 'REJECTED' || s === 'TIMEOUT') return { status: 'FAILED' as const, reason: j.reason ? String(j.reason).slice(0, 100) : s };
      return { status: 'PENDING' as const };
    } catch {
      return { status: 'UNKNOWN' as const };
    }
  }

  verifyWebhook(input: WebhookInput) {
    const token = String(input.query.token ?? '');
    if (!token || !timingSafeEqualStr(token, config.PAYMENT_WEBHOOK_SECRET)) return { ok: false as const };
    try {
      const b = JSON.parse(input.rawBody.toString('utf8'));
      const ref = String(b.referenceId ?? b.externalReference ?? input.headers['x-reference-id'] ?? '');
      if (!ref) return { ok: false as const };
      // MTN sends no event id; financialTransactionId+status is a stable dedup key, else body hash.
      const eventId = crypto.createHash('sha256').update(`${ref}|${b.status ?? ''}|${b.financialTransactionId ?? ''}`).digest('hex');
      return { ok: true as const, providerReference: ref, eventId };
    } catch {
      return { ok: false as const };
    }
  }
}

export const paymentProvider: PaymentProvider | null =
  config.PAYMENT_PROVIDER === 'simulator'
    ? new SimulatorProvider()
    : config.PAYMENT_PROVIDER === 'mtn_momo'
      ? new MtnMomoProvider()
      : null;
