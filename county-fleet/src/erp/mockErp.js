import crypto from 'node:crypto';
import { config } from '../config.js';
import { readJson, sendJson, HttpError } from '../util.js';
import { getSetting, setSetting } from '../settings.js';

/* A stand-in ERP for demos and tests. It speaks the same REST contract a real adapter would use:
 *   POST /documents   (Idempotency-Key header)  -> 200 {reference} | 409 | 422 | 503
 *   GET  /cost-centres, /budgets, /vendors, /health
 * Switched off in production unless ENABLE_DEMO_ERP=1. */

const BASE = '/mock-erp/api/fleet/v1';
const PREFIX = { fuel: 'PV', maint: 'WO', asset: 'FA' };

export function seedMockErp(db) {
  const n = db.prepare('SELECT COUNT(*) n FROM mock_erp_cost_centres').get().n;
  if (n) return;
  const ins = db.prepare('INSERT INTO mock_erp_cost_centres (code, name) VALUES (?,?)');
  [['ROADS-04', 'Roads maintenance'], ['WATER-02', 'Water services'], ['TRANSP-01', 'County transport pool']].forEach((r) => ins.run(...r));
}

function authOk(req) {
  const h = req.headers.authorization || '';
  const given = Buffer.from(h.replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(config.demoErpKey);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

export async function handleMockErp(db, req, res, pathname) {
  if (!config.demoErp) throw new HttpError(404, 'Not found');
  if (!authOk(req)) return sendJson(res, 401, { message: 'Invalid API key' });
  const p = pathname.slice(BASE.length);

  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/cost-centres') {
    const items = db.prepare('SELECT code, name, blocked FROM mock_erp_cost_centres ORDER BY code').all().map((c) => ({ code: c.code, name: c.name, active: !c.blocked }));
    return sendJson(res, 200, { items });
  }
  if (req.method === 'GET' && p === '/budgets') {
    return sendJson(res, 200, {
      fy: '2026/27',
      items: [
        { vote: 'Fuel and lubricants', amount: 22000000 },
        { vote: 'Repairs and maintenance', amount: 3500000 },
      ],
    });
  }
  if (req.method === 'GET' && p === '/vendors') {
    return sendJson(res, 200, { items: [{ code: 'V-1001', name: 'Eldoret Fuel Depot' }, { code: 'V-1002', name: 'Rift Valley Auto Parts' }] });
  }
  if (req.method === 'POST' && p === '/documents') {
    const key = req.headers['idempotency-key'];
    if (!key) return sendJson(res, 400, { message: 'Idempotency-Key header is required' });
    const doc = await readJson(req);
    const existing = db.prepare('SELECT reference FROM mock_erp_documents WHERE idempotency_key = ?').get(key);
    if (existing) return sendJson(res, 200, { reference: existing.reference, duplicate: true });

    const flaky = Number(getSetting(db, 'demo.flaky', 0));
    if (flaky > 0) {
      setSetting(db, 'demo.flaky', flaky - 1);
      return sendJson(res, 503, { message: 'The ERP is busy. Try again shortly.' });
    }
    const cc = doc.asset?.costCentre;
    if (cc) {
      const row = db.prepare('SELECT blocked FROM mock_erp_cost_centres WHERE code = ?').get(cc);
      if (!row) return sendJson(res, 422, { message: `Cost centre ${cc} does not exist in the ERP.` });
      if (row.blocked) return sendJson(res, 422, { message: `Cost centre ${cc} is blocked for posting in the ERP. Ask Finance to reopen it, then retry.` });
    }
    if (doc.event === 'asset' && (doc.changes || []).some((c) => /expiry/.test(c.field)) && !req.headers['x-override']) {
      return sendJson(res, 409, { message: 'Registration or insurance dates differ from the ERP asset record. Confirm which dates are correct.' });
    }
    const seq = db.prepare('SELECT COUNT(*) n FROM mock_erp_documents').get().n + 1;
    const reference = `${PREFIX[doc.event] || 'DOC'}-26-${String(seq).padStart(6, '0')}`;
    db.prepare('INSERT INTO mock_erp_documents (idempotency_key, reference, doc) VALUES (?,?,?)').run(key, reference, JSON.stringify(doc));
    return sendJson(res, 200, { reference });
  }
  throw new HttpError(404, 'Not found');
}

/** Controls used by the ERP console demo buttons (admin only, see routes). */
export function demoBlockCostCentre(db, code, blocked) {
  const r = db.prepare('UPDATE mock_erp_cost_centres SET blocked = ? WHERE code = ?').run(blocked ? 1 : 0, code);
  return r.changes > 0;
}
export function demoFlaky(db, n) {
  setSetting(db, 'demo.flaky', Math.max(0, Math.min(20, Number(n) || 0)));
}
export const MOCK_BASE = BASE;
