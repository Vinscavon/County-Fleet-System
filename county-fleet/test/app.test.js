import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENABLE_DEMO_ERP = '1';
process.env.NODE_ENV = 'test';

const { openDb } = await import('../src/db.js');
const { seed } = await import('../src/seed.js');
const { createApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth.js');
const { seedMockErp, demoFlaky, demoBlockCostCentre } = await import('../src/erp/mockErp.js');
const { processDue, enqueue } = await import('../src/erp/outbox.js');
const { setSetting } = await import('../src/settings.js');

let db, server, base;
const PW = 'Testpass12345';
const jars = {};

async function call(method, path, body, who) {
  const headers = { 'X-Fleet-Client': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (who && jars[who]) headers.Cookie = jars[who];
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.get('set-cookie');
  if (sc && who) jars[who] = sc.split(';')[0];
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function login(role) {
  const r = await call('POST', '/api/login', { email: `${role}@t.local`, password: PW }, role);
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

before(async () => {
  db = openDb(':memory:');
  seed(db, { demo: false, writeFile: false });
  seedMockErp(db);
  const ins = db.prepare('INSERT INTO users (name,email,password_hash,role,must_change_password) VALUES (?,?,?,?,0)');
  for (const role of ['fleet_manager', 'workshop', 'finance', 'driver', 'admin2']) {
    ins.run(role, `${role}@t.local`, hashPassword(PW), role === 'admin2' ? 'admin' : role);
  }
  db.prepare("UPDATE users SET email='admin@t.local' WHERE email='admin2@t.local'").run();
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  setSetting(db, 'erp', {
    adapter: 'rest', profile: 'ifmis', base_url: `${base}/mock-erp/api/fleet/v1`, auth: 'apikey', schedule: 'realtime',
    mapping: { fuel: 'Fuel and lubricants', maint: 'Repairs and maintenance', asset: 'Fixed assets' },
  });
  for (const r of ['fleet_manager', 'workshop', 'finance', 'driver', 'admin']) await login(r);
});

after(() => { server.close(); db.close(); });

const driverId = () => db.prepare("SELECT id FROM users WHERE role='driver'").get().id;
let assetId;

test('asset creation, driver assignment and schedule', async () => {
  const r = await call('POST', '/api/assets', {
    plate: 'KXX 100A', type: 'Motor grader', category: 'heavy', fuel_basis: 'hrs', fuel_rate: 14, meter: 1000,
    service_interval: 250, last_service_meter: 800, cost_centre: 'ROADS-04', assigned_driver_id: driverId(),
  }, 'fleet_manager');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assetId = r.json.id;
  assert.equal(r.json.schedule.state, 'ok'); // next due at 1050, 50 remaining
});

test('auth: wrong password, CSRF header, and role limits', async () => {
  const bad = await call('POST', '/api/login', { email: 'finance@t.local', password: 'nope' });
  assert.equal(bad.status, 401);
  const noHeader = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  assert.equal((await call('GET', '/api/assets')).status, 401);
  assert.equal((await call('GET', '/api/assets', undefined, 'driver')).status, 403);
  assert.equal((await call('GET', '/api/erp', undefined, 'workshop')).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, 'finance')).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, 'admin')).status, 200);
});

test('temporary password must be changed before anything else', async () => {
  const c = await call('POST', '/api/users', { name: 'New Driver', email: 'nd@t.local', role: 'driver' }, 'admin');
  assert.equal(c.status, 200);
  const pw = c.json.temporaryPassword;
  assert.ok(pw && pw.length >= 12);
  const l = await call('POST', '/api/login', { email: 'nd@t.local', password: pw }, 'nd');
  assert.equal(l.status, 200);
  assert.equal(l.json.user.mustChangePassword, true);
  assert.equal((await call('GET', '/api/driver/home', undefined, 'nd')).status, 403);
  assert.equal((await call('POST', '/api/change-password', { current: pw, next: 'short1' }, 'nd')).status, 400);
  assert.equal((await call('POST', '/api/change-password', { current: pw, next: 'Brand-new-pass9' }, 'nd')).status, 200);
  assert.equal((await call('GET', '/api/driver/home', undefined, 'nd')).status, 200);
});

test('drivers can only log fuel for their own vehicle', async () => {
  const other = await call('POST', '/api/assets', { plate: 'KXX 200B', type: 'Tipper', category: 'transport', fuel_basis: 'km', fuel_rate: 32 }, 'fleet_manager');
  const r = await call('POST', '/api/fuel', { asset_id: other.json.id, litres: 50 }, 'driver');
  assert.equal(r.status, 403);
});

test('fuel log computes expected litres and flags big variance; meter cannot go backwards', async () => {
  const back = await call('POST', '/api/fuel', { asset_id: assetId, litres: 100, meter_reading: 900 }, 'driver');
  assert.equal(back.status, 400);
  // 100 h x 14 L/h = 1400 L expected; 2000 L logged is +42.9%
  const r = await call('POST', '/api/fuel', { asset_id: assetId, litres: 2000, meter_reading: 1100 }, 'driver');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.expected_litres, 1400);
  assert.ok(r.json.variance_pct > 40);
  assert.equal(r.json.flag, true);
  assert.equal(r.json.total, 2000 * 195);
});

test('approved fuel goes through the outbox to the ERP once', async () => {
  const log = await call('POST', '/api/fuel', { asset_id: assetId, litres: 120, meter_reading: 1110 }, 'driver');
  const fid = log.json.id;
  assert.equal((await call('POST', `/api/fuel/${fid}/decision`, { decision: 'approve' }, 'driver')).status, 403);
  assert.equal((await call('POST', `/api/fuel/${fid}/decision`, { decision: 'approve' }, 'fleet_manager')).status, 200);
  assert.equal((await call('POST', `/api/fuel/${fid}/decision`, { decision: 'approve' }, 'fleet_manager')).status, 400); // already decided
  const row = db.prepare("SELECT * FROM outbox WHERE ref = ?").get(`FUEL-${fid}`);
  assert.equal(row.status, 'queued');
  const sync = await call('POST', '/api/erp/sync-now', {}, 'finance');
  assert.equal(sync.status, 200);
  const done = db.prepare('SELECT * FROM outbox WHERE ref = ?').get(`FUEL-${fid}`);
  assert.equal(done.status, 'synced');
  assert.match(done.erp_reference, /^PV-26-\d{6}$/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mock_erp_documents').get().n >= 1, true);
});

test('idempotency: the same event is queued once and the ERP returns the same reference', async () => {
  const a = enqueue(db, { kind: 'fuel', ref: 'FUEL-X1', key: 'fuel-x1', assetId, description: 'x', amount: 1, data: { litres: 1, unit_price: 1, total: 1 } });
  const b = enqueue(db, { kind: 'fuel', ref: 'FUEL-X1', key: 'fuel-x1', assetId, description: 'x', amount: 1, data: { litres: 1, unit_price: 1, total: 1 } });
  assert.ok(a);
  assert.equal(b, null);
  await processDue(db, { ignoreBackoff: true });
  const ref1 = db.prepare("SELECT erp_reference FROM outbox WHERE ref='FUEL-X1'").get().erp_reference;
  // simulate a lost reply: put it back in the queue and send again
  db.prepare("UPDATE outbox SET status='queued', erp_reference=NULL WHERE ref='FUEL-X1'").run();
  await processDue(db, { ignoreBackoff: true });
  const ref2 = db.prepare("SELECT erp_reference FROM outbox WHERE ref='FUEL-X1'").get().erp_reference;
  assert.equal(ref2, ref1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM mock_erp_documents WHERE idempotency_key='fleet-fuel-x1'").get().n, 1);
});

test('temporary ERP outage: backoff, then success without duplicates', async () => {
  enqueue(db, { kind: 'fuel', ref: 'FUEL-F1', key: 'fuel-f1', assetId, description: 'flaky', amount: 5, data: { litres: 1, unit_price: 5, total: 5 } });
  demoFlaky(db, 2);
  let r = await processDue(db);
  assert.equal(r.retry, 1);
  let row = db.prepare("SELECT * FROM outbox WHERE ref='FUEL-F1'").get();
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /busy/);
  assert.ok(row.next_attempt_at > new Date().toISOString().replace('T', ' ').slice(0, 19)); // waiting, not due
  r = await processDue(db); // not due yet: nothing sent
  assert.equal(r.sent + r.retry, 0);
  await processDue(db, { ignoreBackoff: true }); // second failure
  r = await processDue(db, { ignoreBackoff: true }); // third time works
  assert.equal(r.sent, 1);
  row = db.prepare("SELECT * FROM outbox WHERE ref='FUEL-F1'").get();
  assert.equal(row.status, 'synced');
  assert.equal(row.attempts, 3);
});

test('rejected by ERP (blocked cost centre): fails, then retry succeeds after Finance reopens it', async () => {
  demoBlockCostCentre(db, 'ROADS-04', true);
  const log = await call('POST', '/api/fuel', { asset_id: assetId, litres: 30, meter_reading: 1115 }, 'driver');
  await call('POST', `/api/fuel/${log.json.id}/decision`, { decision: 'approve' }, 'finance');
  await call('POST', '/api/erp/sync-now', {}, 'finance');
  const row = db.prepare('SELECT * FROM outbox WHERE ref = ?').get(`FUEL-${log.json.id}`);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /blocked/);
  demoBlockCostCentre(db, 'ROADS-04', false);
  assert.equal((await call('POST', `/api/erp/outbox/${row.id}/retry`, {}, 'finance')).status, 200);
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id = ?').get(row.id).status, 'synced');
  assert.equal((await call('POST', `/api/erp/outbox/${row.id}/retry`, {}, 'finance')).status, 400); // only failed can retry
});

test('conflict goes to review and sends only after a person approves', async () => {
  const r = await call('PATCH', `/api/assets/${assetId}`, { registration_expiry: '2027-03-01' }, 'fleet_manager');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await call('POST', '/api/erp/sync-now', {}, 'finance');
  const row = db.prepare("SELECT * FROM outbox WHERE kind='asset' ORDER BY id DESC").get();
  assert.equal(row.status, 'review');
  assert.equal((await call('POST', `/api/erp/outbox/${row.id}/approve`, {}, 'workshop')).status, 403);
  assert.equal((await call('POST', `/api/erp/outbox/${row.id}/approve`, {}, 'finance')).status, 200);
  const after = db.prepare('SELECT * FROM outbox WHERE id = ?').get(row.id);
  assert.equal(after.status, 'synced');
  assert.match(after.erp_reference, /^FA-/);
});

test('repair job lifecycle: open, start, close updates schedule and posts costs', async () => {
  const open = await call('POST', '/api/jobs', { asset_id: assetId, kind: 'service', category: 'Routine service', description: '250 h service' }, 'workshop');
  assert.equal(open.status, 200, JSON.stringify(open.json));
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = ?').get(assetId).status, 'maintenance');
  assert.equal((await call('POST', `/api/jobs/${open.json.id}/start`, { technician: 'Joel' }, 'workshop')).status, 200);
  const close = await call('POST', `/api/jobs/${open.json.id}/close`, { labour_cost: 8000, parts: [{ description: 'Oil filter', qty: 2, unit_cost: 2600 }], meter_at_service: 1115 }, 'workshop');
  assert.equal(close.status, 200, JSON.stringify(close.json));
  assert.equal(close.json.total_cost, 13200);
  const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  assert.equal(a.last_service_meter, 1115);
  assert.notEqual(a.status, 'maintenance');
  assert.equal((await call('POST', `/api/jobs/${open.json.id}/close`, { labour_cost: 1 }, 'workshop')).status, 400);
  await call('POST', '/api/erp/sync-now', {}, 'finance');
  const rows = db.prepare("SELECT status FROM outbox WHERE ref = ?").all(`JOB-${open.json.id}`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === 'synced'));
});

test('reports summary adds up', async () => {
  const r = await call('GET', '/api/reports/summary', undefined, 'finance');
  assert.equal(r.status, 200);
  assert.ok(r.json.counts.total >= 2);
  assert.equal(r.json.monthly.length, 6);
});
