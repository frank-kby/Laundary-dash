import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

/** Lower-case + trim; basic RFC-ish shape check (deliverability is proven only by email). */
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (e.length > 254) return null;
  return z.email().safeParse(e).success ? e : null;
}

/** Accepts 078..., 78..., +25078..., 25078... and returns E.164 (+2507XXXXXXXX). Defaults to Rwanda. */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{6,15}$/.test(cleaned)) return null;
  const candidate = /^2507\d{8}$/.test(cleaned) ? '+' + cleaned : cleaned;
  const p = parsePhoneNumberFromString(candidate, 'RW');
  if (!p || !p.isValid()) return null;
  return p.number; // E.164
}

/** A login identifier is an email if it contains '@', otherwise a phone number. */
export function parseIdentifier(raw: string): { type: 'email' | 'phone'; value: string } | null {
  if (raw.includes('@')) {
    const v = normalizeEmail(raw);
    return v ? { type: 'email', value: v } : null;
  }
  const v = normalizePhone(raw);
  return v ? { type: 'phone', value: v } : null;
}
