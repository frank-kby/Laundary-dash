import { config, isProd } from '../config.js';
import { log } from '../log.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<boolean>;
}

class NoEmail implements EmailProvider {
  readonly configured = false;
  async send() {
    return false;
  }
}

/** Development only: prints the message to stdout so reset links can be tested locally. Refused in production. */
class ConsoleEmail implements EmailProvider {
  readonly configured = true;
  public outbox: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    if (isProd) return false;
    this.outbox.push(msg);
    if (config.NODE_ENV !== 'test') console.log(`\n[DEV EMAIL] to=${msg.to}\nsubject=${msg.subject}\n${msg.text}\n`);
    return true;
  }
}

/** Resend HTTP API (SMTP ports are blocked on Render free). Not exercised without a real API key. */
class ResendEmail implements EmailProvider {
  readonly configured = true;
  async send(msg: EmailMessage) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) log.warn('email_send_failed', { status: r.status, subject: msg.subject });
      return r.ok;
    } catch (e) {
      log.warn('email_send_error', { message: (e as Error).message });
      return false;
    }
  }
}

export const email: EmailProvider =
  config.EMAIL_PROVIDER === 'resend' ? new ResendEmail() : config.EMAIL_PROVIDER === 'console' ? new ConsoleEmail() : new NoEmail();
