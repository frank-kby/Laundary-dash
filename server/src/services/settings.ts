import { config } from '../config.js';
import { one, type Db } from '../db.js';

export interface ContactSettings {
  phone: string; // E.164, e.g. +250788123456
  whatsapp: string; // digits only for wa.me links, e.g. 250788123456
}

/**
 * Business contact numbers shown to customers. Admins edit them in Staff → Settings → Contact;
 * until then the environment defaults (SUPPORT_PHONE / SUPPORT_WHATSAPP) are used.
 */
export async function getContact(db: Db): Promise<ContactSettings & { source: 'settings' | 'environment' }> {
  const row = await one(db, `SELECT value FROM app_settings WHERE key = 'contact'`);
  if (row?.value?.phone && row?.value?.whatsapp) return { phone: row.value.phone, whatsapp: row.value.whatsapp, source: 'settings' };
  return { phone: config.SUPPORT_PHONE, whatsapp: config.SUPPORT_WHATSAPP.replace(/\D/g, ''), source: 'environment' };
}

export async function setContact(db: Db, value: ContactSettings, actorId: string) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('contact', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(value), actorId],
  );
}
