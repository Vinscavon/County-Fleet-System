import { config } from '../config.js';
import { getAdapter } from './adapters.js';
import { buildEnvelope } from './payloads.js';
import { getErpSettings, getSetting, setSetting, audit } from '../settings.js';
import { nowIso } from '../util.js';

/** Add an event to the outbox. Calling twice with the same key does nothing (the key is unique). */
export function enqueue(db, { kind, ref, assetId = null, description, amount = 0, data, key }) {
  const idem = `fleet-${key || ref}`;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO outbox (ref, kind, asset_id, description, amount, data, idempotency_key, status, next_attempt_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'queued', ?, ?, ?)`
    )
    .run(ref, kind, assetId, description, amount, JSON.stringify({ date: nowIso().slice(0, 10), ...data }), idem, nowIso(), nowIso(), nowIso());
  return r.changes ? Number(r.lastInsertRowid) : null;
}

export function listOutbox(db, { status, limit = 200 } = {}) {
  const where = status ? 'WHERE o.status = ?' : '';
  const args = status ? [status, limit] : [limit];
  return db
    .prepare(
      `SELECT o.id, o.ref, o.kind, o.description, o.amount, o.status, o.attempts, o.last_error, o.erp_reference,
              o.created_at, o.updated_at, o.next_attempt_at, a.plate AS asset
       FROM outbox o LEFT JOIN assets a ON a.id = o.asset_id
       ${where} ORDER BY o.id DESC LIMIT ?`
    )
    .all(...args);
}

export function outboxCounts(db) {
  const out = { queued: 0, sending: 0, synced: 0, failed: 0, review: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM outbox GROUP BY status').all()) out[r.status] = r.n;
  return out;
}

export function getOutbox(db, id) {
  const row = db.prepare('SELECT o.*, a.plate AS asset FROM outbox o LEFT JOIN assets a ON a.id = o.asset_id WHERE o.id = ?').get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data), envelope: buildEnvelope(db, row) };
}

const backoffSeconds = (attempts) => config.backoffBaseSeconds * 2 ** Math.max(0, attempts - 1);
const plusSeconds = (s) => new Date(Date.now() + s * 1000).toISOString().replace('T', ' ').slice(0, 19);

let running = false;

/** Send everything that is due. Safe to call from a timer and from a button at the same time. */
export async function processDue(db, { limit = 25, ignoreBackoff = false } = {}) {
  if (running) return { skipped: true };
  running = true;
  const summary = { sent: 0, retry: 0, failed: 0, review: 0 };
  try {
    const adapter = getAdapter(db);
    if (!adapter) return { ...summary, disabled: true };
    const due = db
      .prepare(`SELECT * FROM outbox WHERE status = 'queued' ${ignoreBackoff ? '' : 'AND next_attempt_at <= ?'} ORDER BY id LIMIT ?`)
      .all(...(ignoreBackoff ? [limit] : [nowIso(), limit]));
    for (const row of due) {
      db.prepare("UPDATE outbox SET status='sending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
      let result;
      try {
        result = await adapter.send(buildEnvelope(db, row), row.idempotency_key, !!row.override);
      } catch (e) {
        result = { ok: false, kind: 'retry', message: e.message };
      }
      const attempts = row.attempts + 1;
      if (result.ok) {
        db.prepare("UPDATE outbox SET status='synced', erp_reference=?, last_error=NULL, updated_at=? WHERE id=?").run(result.reference, nowIso(), row.id);
        audit(db, null, 'erp.synced', 'outbox', row.id, `${row.ref} -> ${result.reference}`);
        summary.sent++;
      } else if (result.kind === 'review') {
        db.prepare("UPDATE outbox SET status='review', last_error=?, updated_at=? WHERE id=?").run(result.message, nowIso(), row.id);
        summary.review++;
      } else if (result.kind === 'retry' && attempts < config.maxAttempts) {
        db.prepare("UPDATE outbox SET status='queued', last_error=?, next_attempt_at=?, updated_at=? WHERE id=?").run(result.message, plusSeconds(backoffSeconds(attempts)), nowIso(), row.id);
        summary.retry++;
      } else {
        const msg = result.kind === 'retry' ? `${result.message} (gave up after ${attempts} attempts)` : result.message;
        db.prepare("UPDATE outbox SET status='failed', last_error=?, updated_at=? WHERE id=?").run(msg, nowIso(), row.id);
        audit(db, null, 'erp.failed', 'outbox', row.id, `${row.ref}: ${msg}`);
        summary.failed++;
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

export function retry(db, id, user) {
  const r = db.prepare("UPDATE outbox SET status='queued', attempts=0, next_attempt_at=?, updated_at=? WHERE id=? AND status='failed'").run(nowIso(), nowIso(), id);
  if (r.changes) audit(db, user, 'erp.retry', 'outbox', id);
  return r.changes > 0;
}

/** A person has checked the ERP's concern and confirms the record should be sent anyway. */
export function approve(db, id, user) {
  const r = db.prepare("UPDATE outbox SET status='queued', override=1, attempts=0, next_attempt_at=?, updated_at=? WHERE id=? AND status='review'").run(nowIso(), nowIso(), id);
  if (r.changes) audit(db, user, 'erp.approve', 'outbox', id);
  return r.changes > 0;
}

/** Bring cost centres, budgets and vendors from the ERP into the fleet system. */
export async function pullMasters(db, user = null) {
  const adapter = getAdapter(db);
  if (!adapter) throw new Error('ERP integration is switched off, or no ERP address is set yet');
  const stamp = nowIso();
  const out = {};
  const cc = await adapter.pull('cost-centres');
  const ins = db.prepare('INSERT INTO cost_centres (code, name, active, synced_at) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, active=excluded.active, synced_at=excluded.synced_at');
  for (const c of cc.items || []) ins.run(String(c.code), String(c.name), c.active === false ? 0 : 1, stamp);
  out.costCentres = (cc.items || []).length;
  const b = await adapter.pull('budgets');
  const insB = db.prepare('INSERT INTO budgets (fy, vote, amount, synced_at) VALUES (?,?,?,?) ON CONFLICT(fy, vote) DO UPDATE SET amount=excluded.amount, synced_at=excluded.synced_at');
  for (const x of b.items || []) insB.run(String(b.fy), String(x.vote), Number(x.amount), stamp);
  out.budgets = (b.items || []).length;
  const v = await adapter.pull('vendors');
  const insV = db.prepare('INSERT INTO vendors (code, name, synced_at) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, synced_at=excluded.synced_at');
  for (const x of v.items || []) insV.run(String(x.code), String(x.name), stamp);
  out.vendors = (v.items || []).length;
  setSetting(db, 'erp.last_pull', stamp);
  audit(db, user, 'erp.pull', 'masters', null, JSON.stringify(out));
  return out;
}

function scheduleAllows(db) {
  const s = getErpSettings(db).schedule;
  if (s === 'realtime') return true;
  const last = getSetting(db, 'erp.last_run', null);
  const now = new Date();
  if (s === 'hourly') return !last || Date.now() - Date.parse(last.replace(' ', 'T') + 'Z') >= 3600e3;
  if (s === 'nightly') return now.getHours() >= 22 && (!last || last.slice(0, 10) !== nowIso().slice(0, 10));
  return true;
}

export function startWorker(db) {
  // Anything left in 'sending' by a crash goes back in the queue.
  db.prepare("UPDATE outbox SET status='queued' WHERE status='sending'").run();
  const tick = async () => {
    try {
      if (!scheduleAllows(db)) return;
      const r = await processDue(db);
      if (!r.skipped && !r.disabled) setSetting(db, 'erp.last_run', nowIso());
      const lastPull = getSetting(db, 'erp.last_pull', null);
      if (!lastPull || Date.now() - Date.parse(lastPull.replace(' ', 'T') + 'Z') > 24 * 3600e3) {
        if (getErpSettings(db).base_url || getErpSettings(db).adapter === 'file') await pullMasters(db).catch(() => {});
      }
    } catch (e) {
      console.error('ERP worker error:', e.message);
    }
  };
  const timer = setInterval(tick, config.syncIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
