import { config } from './config.js';
import { tx } from './db.js';
import {
  HttpError, bad, notFound, forbidden, validate, nowIso,
} from './util.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, randomPassword, createSession, destroySession,
  destroyUserSessions, sessionCookie, checkLoginAllowed, recordLoginFailure, clearLoginFailures, ROLES,
} from './auth.js';
import { getSetting, setSetting, getErpSettings, audit } from './settings.js';
import * as svc from './services.js';
import { PROFILES } from './erp/payloads.js';
import { getAdapter } from './erp/adapters.js';
import { listOutbox, outboxCounts, getOutbox, retry, approve, processDue, pullMasters } from './erp/outbox.js';
import { demoBlockCostCentre, demoFlaky, MOCK_BASE } from './erp/mockErp.js';

const STAFF = ['fleet_manager', 'workshop', 'finance'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, mustChangePassword: !!u.mustChangePassword });
const id = (p) => Number(p.id);

export const routes = [];
/** roles: null = open, 'any' = any signed-in user, array = those roles (admin always allowed). */
const add = (method, path, roles, handler) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
  routes.push({ method, re, keys, roles, handler });
};

/* ---------- session ---------- */

add('POST', '/api/login', null, ({ db, body, req, res }) => {
  const v = validate(body, { email: 'string', password: 'string' });
  const key = `${v.email.toLowerCase()}|${req.socket.remoteAddress}`;
  checkLoginAllowed(key);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(v.email);
  // Run the hash check even for unknown emails so response time does not reveal which emails exist.
  const ok = verifyPassword(v.password, row ? row.password_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==') && row && row.active;
  if (!ok) {
    recordLoginFailure(key);
    audit(db, null, 'login.failed', 'user', null, v.email);
    throw new HttpError(401, 'Email or password is not correct');
  }
  clearLoginFailures(key);
  const token = createSession(db, row.id);
  audit(db, { id: row.id, name: row.name }, 'login', 'user', row.id);
  res.setHeader('Set-Cookie', sessionCookie(token, config.sessionHours * 3600));
  return { user: publicUser({ ...row, mustChangePassword: row.must_change_password }) };
});

add('POST', '/api/logout', 'any', ({ db, user, res }) => {
  destroySession(db, user.token);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

add('GET', '/api/me', 'any', ({ db, user }) => ({
  user: publicUser(user),
  settings: { dieselPrice: getSetting(db, 'diesel_price'), fy: svc.fyOf().label },
}));

add('POST', '/api/change-password', 'any', ({ db, user, body, res }) => {
  const v = validate(body, { current: 'string', next: 'string' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(v.current, row.password_hash)) throw bad('Your current password is not correct');
  checkPasswordStrength(v.next);
  if (v.next === v.current) throw bad('Choose a different password from the current one');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(v.next), user.id);
  destroyUserSessions(db, user.id);
  res.setHeader('Set-Cookie', sessionCookie(createSession(db, user.id), config.sessionHours * 3600));
  audit(db, user, 'password.change', 'user', user.id);
  return { ok: true };
});

/* ---------- settings ---------- */

add('GET', '/api/settings', 'any', ({ db }) => ({ dieselPrice: getSetting(db, 'diesel_price') }));
add('PUT', '/api/settings/diesel-price', ['finance'], ({ db, user, body }) => {
  const v = validate(body, { price: 'number' });
  if (v.price <= 0 || v.price > 1000) throw bad('Price looks wrong');
  setSetting(db, 'diesel_price', v.price);
  audit(db, user, 'settings.diesel', 'settings', null, String(v.price));
  return { dieselPrice: v.price };
});

/* ---------- assets and drivers ---------- */

add('GET', '/api/assets', STAFF, ({ db }) => svc.listAssets(db));
add('GET', '/api/assets/:id', STAFF, ({ db, params }) => ({ asset: svc.getAsset(db, id(params)), ...svc.assetHistory(db, id(params)) }));
add('POST', '/api/assets', ['fleet_manager'], ({ db, user, body }) => svc.createAsset(db, user, body));
add('PATCH', '/api/assets/:id', ['fleet_manager'], ({ db, user, body, params }) => svc.updateAsset(db, user, id(params), body));
add('POST', '/api/assets/:id/meter', ['fleet_manager', 'workshop'], ({ db, user, body, params }) => svc.recordMeter(db, user, id(params), body));
add('GET', '/api/drivers', ['fleet_manager', 'finance'], ({ db }) => svc.listDrivers(db));
add('GET', '/api/lookups', STAFF, ({ db }) => ({
  costCentres: db.prepare('SELECT code, name FROM cost_centres WHERE active = 1 ORDER BY code').all(),
  drivers: db.prepare("SELECT id, name FROM users WHERE role = 'driver' AND active = 1 ORDER BY name").all(),
}));

/* ---------- fuel ---------- */

add('GET', '/api/fuel', ['fleet_manager', 'finance'], ({ db, query }) =>
  svc.listFuel(db, { status: query.get('status') || undefined, assetId: Number(query.get('asset')) || undefined }));
add('POST', '/api/fuel', ['driver', 'fleet_manager'], ({ db, user, body }) => svc.logFuel(db, user, body));
add('POST', '/api/fuel/:id/decision', ['fleet_manager', 'finance'], ({ db, user, body, params }) => svc.decideFuel(db, user, id(params), body));

/* ---------- jobs ---------- */

add('GET', '/api/jobs', ['fleet_manager', 'workshop', 'finance'], ({ db, query }) =>
  svc.listJobs(db, { status: query.get('status') || undefined, assetId: Number(query.get('asset')) || undefined }));
add('GET', '/api/jobs/:id', ['fleet_manager', 'workshop', 'finance'], ({ db, params }) => svc.getJob(db, id(params)));
add('POST', '/api/jobs', ['fleet_manager', 'workshop'], ({ db, user, body }) => svc.openJob(db, user, body));
add('POST', '/api/jobs/:id/start', ['fleet_manager', 'workshop'], ({ db, user, body, params }) => svc.startJob(db, user, id(params), body));
add('POST', '/api/jobs/:id/close', ['fleet_manager', 'workshop'], ({ db, user, body, params }) => svc.closeJob(db, user, id(params), body));
add('POST', '/api/report-fault', ['driver'], ({ db, user, body }) => svc.openJob(db, user, { ...body, kind: 'repair' }, { asDriver: true }));

/* ---------- driver home ---------- */

add('GET', '/api/driver/home', ['driver'], ({ db, user }) => {
  const assets = svc.listAssets(db).filter((a) => a.assigned_driver_id === user.id);
  return {
    assets,
    fuel: svc.listFuel(db, { driverId: user.id, limit: 10 }),
    jobs: assets.flatMap((a) => svc.listJobs(db, { status: 'active', assetId: a.id })),
    dieselPrice: getSetting(db, 'diesel_price'),
  };
});

/* ---------- reports ---------- */

add('GET', '/api/reports/summary', STAFF, ({ db }) => svc.summary(db));

/* ---------- ERP ---------- */

const ERP_ROLES = ['finance'];
const demoUrl = () => `http://127.0.0.1:${config.port}${MOCK_BASE}`;

function erpOverview(db) {
  const s = getErpSettings(db);
  return {
    settings: s,
    profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, p]) => [k, p.name])),
    secrets: { apiKey: !!config.erp.apiKey, oauth: !!(config.erp.clientId && config.erp.clientSecret && config.erp.tokenUrl) },
    demo: { enabled: config.demoErp, url: config.demoErp ? demoUrl() : null },
    counts: outboxCounts(db),
    lastRun: getSetting(db, 'erp.last_run', null),
    lastPull: getSetting(db, 'erp.last_pull', null),
    costCentres: db.prepare('SELECT code, name, active, synced_at FROM cost_centres ORDER BY code').all(),
    vendors: db.prepare('SELECT code, name FROM vendors ORDER BY code').all(),
    budgets: db.prepare('SELECT fy, vote, amount FROM budgets ORDER BY fy DESC, vote').all(),
  };
}

add('GET', '/api/erp', ERP_ROLES, ({ db }) => erpOverview(db));

add('PUT', '/api/erp/settings', ERP_ROLES, ({ db, user, body }) => {
  const v = validate(body, {
    adapter: ['rest', 'file', 'off'],
    profile: Object.keys(PROFILES),
    '?base_url': 'string',
    auth: ['apikey', 'oauth'],
    schedule: ['realtime', 'hourly', 'nightly'],
  });
  const m = validate(body.mapping || {}, { fuel: 'string', maint: 'string', asset: 'string' });
  const base = v.base_url || '';
  if (base) {
    let u;
    try { u = new URL(base); } catch { throw bad('The ERP address is not a valid web address'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('The ERP address must start with https://');
    const isDemo = config.demoErp && u.hostname === '127.0.0.1' && u.pathname.startsWith('/mock-erp');
    if (config.production && u.protocol !== 'https:' && !isDemo) throw bad('In production the ERP address must use https://');
  }
  if (v.adapter === 'rest' && !base) throw bad('Enter the ERP address, or choose the file export option');
  setSetting(db, 'erp', { ...v, base_url: base, mapping: m });
  audit(db, user, 'erp.settings', 'settings', null, `${v.adapter}/${v.profile}/${v.schedule}`);
  return erpOverview(db);
});

add('POST', '/api/erp/test', ERP_ROLES, async ({ db }) => {
  const a = getAdapter(db);
  if (!a) return { ok: false, message: 'ERP integration is switched off, or no ERP address is set yet' };
  return a.ping();
});

add('GET', '/api/erp/outbox', ERP_ROLES, ({ db, query }) => listOutbox(db, { status: query.get('status') || undefined }));
add('GET', '/api/erp/outbox/:id', ERP_ROLES, ({ db, params }) => getOutbox(db, id(params)) || notFound('Record not found'));
add('POST', '/api/erp/outbox/:id/retry', ERP_ROLES, async ({ db, user, params }) => {
  if (!retry(db, id(params), user)) throw bad('Only a failed record can be retried');
  return { ...(await processDue(db, { ignoreBackoff: true })), counts: outboxCounts(db) };
});
add('POST', '/api/erp/outbox/:id/approve', ERP_ROLES, async ({ db, user, params }) => {
  if (!approve(db, id(params), user)) throw bad('Only a record under review can be approved');
  return { ...(await processDue(db, { ignoreBackoff: true })), counts: outboxCounts(db) };
});
add('POST', '/api/erp/sync-now', ERP_ROLES, async ({ db, user }) => {
  audit(db, user, 'erp.sync-now', 'outbox');
  return { ...(await processDue(db, { ignoreBackoff: true })), counts: outboxCounts(db) };
});
add('POST', '/api/erp/pull', ERP_ROLES, async ({ db, user }) => {
  try { return await pullMasters(db, user); } catch (e) { throw new HttpError(502, `Could not read from the ERP: ${e.message}`); }
});

add('POST', '/api/erp/demo', ['admin'], ({ db, user, body }) => {
  if (!config.demoErp) throw notFound();
  const v = validate(body, { action: ['block', 'unblock', 'flaky'], '?code': 'string', '?n': 'int' });
  if (v.action === 'flaky') demoFlaky(db, v.n ?? 2);
  else if (!v.code || !demoBlockCostCentre(db, v.code, v.action === 'block')) throw bad('Unknown cost centre');
  audit(db, user, `erp.demo.${v.action}`, 'demo', null, v.code ?? String(v.n ?? ''));
  return { ok: true };
});

/* ---------- users (admin) ---------- */

add('GET', '/api/users', ['admin'], ({ db }) =>
  db.prepare('SELECT id, name, email, role, active, must_change_password, created_at FROM users ORDER BY name').all());

add('POST', '/api/users', ['admin'], ({ db, user, body }) => {
  const v = validate(body, { name: 'string', email: 'string', role: ROLES, '?password': 'string' });
  if (!EMAIL.test(v.email)) throw bad('That email address does not look right');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(v.email)) throw bad('A user with that email already exists');
  let temp = null;
  let pw = v.password;
  if (pw) checkPasswordStrength(pw);
  else pw = temp = randomPassword();
  const r = db.prepare('INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?,?,?,?,1)').run(v.name, v.email, hashPassword(pw), v.role);
  audit(db, user, 'user.create', 'user', r.lastInsertRowid, `${v.email} (${v.role})`);
  return { id: Number(r.lastInsertRowid), temporaryPassword: temp };
});

add('PATCH', '/api/users/:id', ['admin'], ({ db, user, body, params }) => {
  const uid = id(params);
  const v = validate(body, { '?name': 'string', '?role': ROLES, '?active': 'int' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!target) throw notFound('User not found');
  if (uid === user.id && (v.role || v.active === 0)) throw forbidden('You cannot change your own role or deactivate yourself');
  tx(db, () => {
    if (v.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(v.name, uid);
    if (v.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(v.role, uid);
    if (v.active !== undefined) {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(v.active ? 1 : 0, uid);
      if (!v.active) destroyUserSessions(db, uid);
    }
    audit(db, user, 'user.update', 'user', uid, JSON.stringify(v));
  });
  return { ok: true };
});

add('POST', '/api/users/:id/reset-password', ['admin'], ({ db, user, params }) => {
  const uid = id(params);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) throw notFound('User not found');
  const temp = randomPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(temp), uid);
  destroyUserSessions(db, uid);
  audit(db, user, 'user.reset-password', 'user', uid);
  return { temporaryPassword: temp };
});

add('GET', '/api/audit', ['admin'], ({ db }) => db.prepare('SELECT id, user_name, action, entity, entity_id, detail, at FROM audit_log ORDER BY id DESC LIMIT 200').all());
