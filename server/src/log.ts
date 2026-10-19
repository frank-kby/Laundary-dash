/**
 * Minimal structured logger. Callers must never pass passwords, tokens, cookies, payment secrets
 * or full phone numbers. `redact` is a last line of defence for well-known key names.
 */
const SENSITIVE = /pass(word)?|token|secret|cookie|authorization|api[_-]?key|pin|signature/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function write(level: string, msg: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(data ?? {}) as object) });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
};

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.length > 7 ? phone.slice(0, 6) + '****' + phone.slice(-3) : '****';
}
