import { nowIso } from './util.js';

const DEFAULTS = {
  diesel_price: 195,
  erp: {
    adapter: 'rest', // rest | file | off
    profile: 'rest', // which ERP's object names to use in payloads
    base_url: '',
    auth: 'apikey', // apikey | oauth
    schedule: 'realtime', // realtime | hourly | nightly
    mapping: { fuel: 'Fuel and lubricants', maint: 'Repairs and maintenance', asset: 'Fixed assets' },
  },
};

export function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback !== undefined ? fallback : DEFAULTS[key];
  return JSON.parse(row.value);
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function getErpSettings(db) {
  const s = getSetting(db, 'erp', DEFAULTS.erp);
  return { ...DEFAULTS.erp, ...s, mapping: { ...DEFAULTS.erp.mapping, ...(s.mapping || {}) } };
}

export function audit(db, user, action, entity, entityId, detail) {
  db.prepare(
    'INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, detail, at) VALUES (?,?,?,?,?,?,?)'
  ).run(user?.id ?? null, user?.name ?? 'system', action, entity ?? null, entityId != null ? String(entityId) : null, detail ?? null, nowIso());
}
