import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getErpSettings } from '../settings.js';

/* An adapter exposes:
 *   send(envelope, idempotencyKey, override) -> { ok:true, reference } | { ok:false, kind:'retry'|'reject'|'review', message }
 *   ping()  -> { ok, message }
 *   pull(what) -> { items: [...], fy? }     what = 'cost-centres' | 'budgets' | 'vendors'
 * Write a new adapter for any ERP that does not speak the generic REST contract in README.md. */

const isDemoUrl = (u) => {
  try {
    const url = new URL(u);
    return config.demoErp && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.startsWith('/mock-erp');
  } catch { return false; }
};

let tokenCache = { token: null, exp: 0 };

async function authHeader(settings) {
  if (isDemoUrl(settings.base_url)) return { Authorization: `Bearer ${config.demoErpKey}` };
  if (settings.auth === 'oauth') {
    if (!config.erp.tokenUrl || !config.erp.clientId || !config.erp.clientSecret)
      throw new Error('OAuth is selected but ERP_TOKEN_URL, ERP_CLIENT_ID or ERP_CLIENT_SECRET is not set on the server');
    if (tokenCache.token && tokenCache.exp > Date.now() + 30e3) return { Authorization: `Bearer ${tokenCache.token}` };
    const res = await fetch(config.erp.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.erp.clientId, client_secret: config.erp.clientSecret }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Token request failed (${res.status})`);
    const j = await res.json();
    tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 300) * 1000 };
    return { Authorization: `Bearer ${tokenCache.token}` };
  }
  if (!config.erp.apiKey) throw new Error('ERP_API_KEY is not set on the server');
  return { Authorization: `Bearer ${config.erp.apiKey}` };
}

function restAdapter(settings) {
  const base = String(settings.base_url || '').replace(/\/+$/, '');
  const call = async (method, p, opts = {}) => {
    if (!base) throw new Error('The ERP address is not set. Add it under ERP settings.');
    const headers = { Accept: 'application/json', ...(await authHeader(settings)), ...(opts.headers || {}) };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(base + p, { method, headers, body: opts.body, signal: AbortSignal.timeout(10000) });
  };
  return {
    async send(envelope, key, override) {
      let res;
      try {
        res = await call('POST', '/documents', {
          body: JSON.stringify(envelope),
          headers: { 'Idempotency-Key': key, ...(override ? { 'X-Override': 'true' } : {}) },
        });
      } catch (e) {
        return { ok: false, kind: 'retry', message: `Could not reach the ERP: ${e.message}` };
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (!body.reference) return { ok: false, kind: 'reject', message: 'The ERP accepted the record but returned no reference' };
        return { ok: true, reference: String(body.reference) };
      }
      const msg = body.message || `The ERP returned status ${res.status}`;
      if (res.status === 409) return { ok: false, kind: 'review', message: msg };
      if (res.status === 401 || res.status === 403) return { ok: false, kind: 'reject', message: 'The ERP refused the credentials. Check the API key or client secret.' };
      if (res.status === 408 || res.status === 429 || res.status >= 500) return { ok: false, kind: 'retry', message: msg };
      return { ok: false, kind: 'reject', message: msg };
    },
    async ping() {
      try {
        const res = await call('GET', '/health');
        return res.ok ? { ok: true, message: 'Connected' } : { ok: false, message: `The ERP answered with status ${res.status}` };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
    async pull(what) {
      const res = await call('GET', `/${what}`);
      if (!res.ok) throw new Error(`The ERP answered with status ${res.status} for ${what}`);
      return res.json();
    },
  };
}

/** For ERPs that import files (for example a scheduled upload into IFMIS): one JSON file per record. */
function fileAdapter() {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  return {
    async send(envelope, key) {
      try {
        const dir = path.join(config.exportDir, new Date().toISOString().slice(0, 10));
        fs.mkdirSync(dir, { recursive: true });
        const name = `${safe(envelope.reference)}-${safe(envelope.event)}-${safe(envelope.phase || 'x')}.json`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify(envelope, null, 2), { flag: 'wx' });
        return { ok: true, reference: `file:${name}` };
      } catch (e) {
        if (e.code === 'EEXIST') return { ok: true, reference: 'file:already-exported' };
        return { ok: false, kind: 'retry', message: `Could not write the export file: ${e.message}` };
      }
    },
    async ping() {
      try { fs.mkdirSync(config.exportDir, { recursive: true }); fs.accessSync(config.exportDir, fs.constants.W_OK); return { ok: true, message: `Export folder is writable (${config.exportDir})` }; }
      catch (e) { return { ok: false, message: e.message }; }
    },
    async pull(what) {
      const f = path.join(config.importDir, `${what}.json`);
      if (!fs.existsSync(f)) return { items: [] };
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
  };
}

export function getAdapter(db) {
  const s = getErpSettings(db);
  if (s.adapter === 'off' || (s.adapter === 'rest' && !s.base_url)) return null; // not set up: records wait in the queue
  return s.adapter === 'file' ? fileAdapter() : restAdapter(s);
}
