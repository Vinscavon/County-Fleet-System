import { tx } from './db.js';
import { bad, notFound, forbidden, validate, nowIso, round2 } from './util.js';
import { getSetting, audit } from './settings.js';
import { enqueue } from './erp/outbox.js';

/* ---------- helpers ---------- */

export function fyOf(date = new Date()) {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 6 ? y : y - 1;
  return { label: `${start}/${String(start + 1).slice(2)}`, start: `${start}-07-01`, end: `${start + 1}-06-30` };
}

const daysUntil = (d) => (d ? Math.ceil((Date.parse(d) - Date.now()) / 86400e3) : null);
const expiryState = (days) => (days == null ? 'none' : days < 0 ? 'expired' : days <= 30 ? 'soon' : 'ok');

/** Service schedule from meter readings: due when meter reaches last service + interval. */
export function scheduleOf(a) {
  if (!a.service_interval) return { next_due: null, remaining: null, state: 'none' };
  const next = a.last_service_meter + a.service_interval;
  const remaining = round2(next - a.meter);
  const state = remaining < 0 ? 'overdue' : remaining <= a.service_interval * 0.1 ? 'soon' : 'ok';
  return { next_due: next, remaining, state };
}

function decorate(a) {
  const regDays = daysUntil(a.registration_expiry);
  const insDays = daysUntil(a.insurance_expiry);
  return {
    ...a,
    unit: a.fuel_basis === 'km' ? 'km' : 'hrs',
    schedule: scheduleOf(a),
    registration: { days: regDays, state: expiryState(regDays) },
    insurance: { days: insDays, state: expiryState(insDays) },
  };
}

/* ---------- assets ---------- */

const ASSET_SELECT = `SELECT a.*, u.name AS driver_name,
  (SELECT COUNT(*) FROM jobs j WHERE j.asset_id = a.id AND j.status != 'closed') AS open_jobs
  FROM assets a LEFT JOIN users u ON u.id = a.assigned_driver_id`;

export function listAssets(db) {
  return db.prepare(`${ASSET_SELECT} WHERE a.status != 'retired' ORDER BY a.plate`).all().map(decorate);
}

export function getAsset(db, id) {
  const a = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(id);
  if (!a) throw notFound('Asset not found');
  return decorate(a);
}

const ASSET_FIELDS = {
  plate: 'string',
  type: 'string',
  category: ['heavy', 'transport'],
  '?make_model': 'string',
  '?year_made': 'int',
  '?year_purchased': 'int',
  '?erp_asset_no': 'string',
  '?cost_centre': 'string',
  '?status': ['active', 'idle', 'maintenance', 'retired'],
  fuel_basis: ['km', 'hrs'],
  '?fuel_rate': 'number',
  '?meter': 'number',
  '?service_interval': 'number',
  '?last_service_meter': 'number',
  '?location': 'string',
  '?registration_expiry': 'date',
  '?insurance_expiry': 'date',
  '?assigned_driver_id': 'int',
};

function checkDriver(db, id) {
  if (id == null) return;
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'driver' AND active = 1").get(id);
  if (!u) throw bad('The chosen driver does not exist or is not active');
}

export function createAsset(db, user, body) {
  const v = validate(body, ASSET_FIELDS);
  checkDriver(db, v.assigned_driver_id);
  if (v.meter < 0 || v.fuel_rate < 0 || v.service_interval < 0) throw bad('Numbers cannot be negative');
  const dup = db.prepare('SELECT id FROM assets WHERE plate = ?').get(v.plate);
  if (dup) throw bad(`An asset with the number ${v.plate} already exists`);
  const r = db
    .prepare(
      `INSERT INTO assets (plate,type,category,make_model,year_made,year_purchased,erp_asset_no,cost_centre,status,fuel_basis,fuel_rate,meter,service_interval,last_service_meter,location,registration_expiry,insurance_expiry,assigned_driver_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(v.plate, v.type, v.category, v.make_model ?? '', v.year_made ?? null, v.year_purchased ?? null, v.erp_asset_no ?? null, v.cost_centre ?? null, v.status ?? 'idle', v.fuel_basis, v.fuel_rate ?? 0, v.meter ?? 0, v.service_interval ?? 0, v.last_service_meter ?? v.meter ?? 0, v.location ?? '', v.registration_expiry ?? null, v.insurance_expiry ?? null, v.assigned_driver_id ?? null);
  const id = Number(r.lastInsertRowid);
  audit(db, user, 'asset.create', 'asset', id, v.plate);
  return getAsset(db, id);
}

const ERP_WATCHED = ['registration_expiry', 'insurance_expiry', 'cost_centre', 'erp_asset_no'];

export function updateAsset(db, user, id, body) {
  const before = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!before) throw notFound('Asset not found');
  const spec = Object.fromEntries(Object.entries(ASSET_FIELDS).map(([k, t]) => [k.startsWith('?') ? k : `?${k}`, t]));
  const v = validate(body, spec);
  // An explicit null or empty value means "no driver"; validate() would otherwise skip it.
  if ('assigned_driver_id' in body && (body.assigned_driver_id === null || body.assigned_driver_id === '')) v.assigned_driver_id = null;
  if (v.assigned_driver_id !== undefined) checkDriver(db, v.assigned_driver_id);
  const keys = Object.keys(v);
  if (!keys.length) throw bad('Nothing to change');
  if (v.plate && v.plate.toLowerCase() !== before.plate.toLowerCase() && db.prepare('SELECT id FROM assets WHERE plate = ?').get(v.plate))
    throw bad(`An asset with the number ${v.plate} already exists`);
  tx(db, () => {
    db.prepare(`UPDATE assets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
    const changes = ERP_WATCHED.filter((k) => k in v && v[k] !== before[k]).map((k) => ({ field: k, from: before[k], to: v[k] }));
    if (changes.length) {
      enqueue(db, {
        kind: 'asset',
        ref: `ASSET-${id}-${Date.now()}`,
        assetId: id,
        description: `Asset record update: ${changes.map((c) => c.field).join(', ')}`,
        data: { changes },
      });
    }
    audit(db, user, 'asset.update', 'asset', id, keys.join(', '));
  });
  return getAsset(db, id);
}

export function recordMeter(db, user, id, body) {
  const v = validate(body, { meter: 'number' });
  const a = db.prepare('SELECT meter FROM assets WHERE id = ?').get(id);
  if (!a) throw notFound('Asset not found');
  if (v.meter < a.meter) throw bad(`The meter cannot go backwards. Last reading is ${a.meter}.`);
  db.prepare('UPDATE assets SET meter = ? WHERE id = ?').run(v.meter, id);
  audit(db, user, 'asset.meter', 'asset', id, String(v.meter));
  return getAsset(db, id);
}

export function listDrivers(db) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.email, u.active,
        (SELECT GROUP_CONCAT(a.plate, ', ') FROM assets a WHERE a.assigned_driver_id = u.id) AS assets
       FROM users u WHERE u.role = 'driver' ORDER BY u.name`
    )
    .all();
}

/* ---------- fuel ---------- */

export function expectedLitres(asset, meterReading) {
  if (!asset.fuel_rate || meterReading == null) return null;
  const used = meterReading - asset.meter;
  if (used <= 0) return null;
  return round2(asset.fuel_basis === 'km' ? (used * asset.fuel_rate) / 100 : used * asset.fuel_rate);
}

export function logFuel(db, user, body) {
  const v = validate(body, { asset_id: 'int', litres: 'number', '?unit_price': 'number', '?meter_reading': 'number' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(v.asset_id);
  if (!asset || asset.status === 'retired') throw notFound('Asset not found');
  if (user.role === 'driver' && asset.assigned_driver_id !== user.id) throw forbidden('You can only record fuel for the vehicle assigned to you');
  if (v.litres <= 0 || v.litres > 2000) throw bad('Litres must be between 0 and 2000');
  const price = v.unit_price ?? getSetting(db, 'diesel_price');
  if (price <= 0 || price > 1000) throw bad('Fuel price looks wrong');
  if (v.meter_reading != null && v.meter_reading < asset.meter) throw bad(`The meter cannot go backwards. Last reading is ${asset.meter}.`);
  const expected = expectedLitres(asset, v.meter_reading);
  const variance = expected ? round2(((v.litres - expected) / expected) * 100) : null;
  const total = round2(v.litres * price);
  const id = tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO fuel_logs (asset_id, driver_id, litres, unit_price, total, meter_reading, expected_litres, variance_pct, cost_centre)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(asset.id, user.id, v.litres, price, total, v.meter_reading ?? null, expected, variance, asset.cost_centre);
    if (v.meter_reading != null) db.prepare('UPDATE assets SET meter = ? WHERE id = ?').run(v.meter_reading, asset.id);
    audit(db, user, 'fuel.log', 'fuel', r.lastInsertRowid, `${asset.plate} ${v.litres} L`);
    return Number(r.lastInsertRowid);
  });
  return getFuel(db, id);
}

const FUEL_SELECT = `SELECT f.*, a.plate, a.type, a.fuel_basis, d.name AS driver_name, p.name AS decided_by_name
  FROM fuel_logs f JOIN assets a ON a.id = f.asset_id
  LEFT JOIN users d ON d.id = f.driver_id LEFT JOIN users p ON p.id = f.decided_by`;

const flagged = (f) => ({ ...f, flag: f.variance_pct != null && Math.abs(f.variance_pct) > 20 });

export function getFuel(db, id) {
  const f = db.prepare(`${FUEL_SELECT} WHERE f.id = ?`).get(id);
  if (!f) throw notFound('Fuel record not found');
  return flagged(f);
}

export function listFuel(db, { status, assetId, driverId, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('f.status = ?'); args.push(status); }
  if (assetId) { where.push('f.asset_id = ?'); args.push(assetId); }
  if (driverId) { where.push('f.driver_id = ?'); args.push(driverId); }
  return db
    .prepare(`${FUEL_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.id DESC LIMIT ?`)
    .all(...args, Math.min(limit, 500))
    .map(flagged);
}

export function decideFuel(db, user, id, body) {
  const { decision } = validate(body, { decision: ['approve', 'reject'] });
  tx(db, () => {
    const f = db.prepare('SELECT * FROM fuel_logs WHERE id = ?').get(id);
    if (!f) throw notFound('Fuel record not found');
    if (f.status !== 'submitted') throw bad(`This record is already ${f.status}`);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE fuel_logs SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(status, user.id, nowIso(), id);
    if (decision === 'approve') {
      const a = db.prepare('SELECT plate FROM assets WHERE id = ?').get(f.asset_id);
      const driver = f.driver_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(f.driver_id) : null;
      enqueue(db, {
        kind: 'fuel',
        ref: `FUEL-${id}`,
        key: `fuel-${id}`,
        assetId: f.asset_id,
        description: `Fuel ${f.litres} L for ${a.plate}`,
        amount: f.total,
        data: { litres: f.litres, unit_price: f.unit_price, total: f.total, meter_reading: f.meter_reading, cost_centre: f.cost_centre, driver_name: driver?.name ?? null },
      });
    }
    audit(db, user, `fuel.${decision}`, 'fuel', id);
  });
  return getFuel(db, id);
}

/* ---------- repair and service jobs ---------- */

const JOB_SELECT = `SELECT j.*, a.plate, a.type, a.fuel_basis FROM jobs j JOIN assets a ON a.id = j.asset_id`;

export function getJob(db, id) {
  const j = db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id);
  if (!j) throw notFound('Job not found');
  j.parts = db.prepare('SELECT id, description, qty, unit_cost, ROUND(qty * unit_cost, 2) AS line_total FROM job_parts WHERE job_id = ?').all(id);
  return j;
}

export function listJobs(db, { status, assetId, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status === 'active') where.push("j.status != 'closed'");
  else if (status) { where.push('j.status = ?'); args.push(status); }
  if (assetId) { where.push('j.asset_id = ?'); args.push(assetId); }
  return db.prepare(`${JOB_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.id DESC LIMIT ?`).all(...args, Math.min(limit, 500));
}

export function openJob(db, user, body, { asDriver = false } = {}) {
  const v = validate(body, { asset_id: 'int', kind: asDriver ? ['repair'] : ['repair', 'service'], category: 'string', description: 'string' });
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(v.asset_id);
  if (!asset) throw notFound('Asset not found');
  if (asDriver && asset.assigned_driver_id !== user.id) throw forbidden('You can only report faults on the vehicle assigned to you');
  return tx(db, () => {
    const r = db.prepare('INSERT INTO jobs (asset_id, kind, category, description, opened_by) VALUES (?,?,?,?,?)').run(v.asset_id, v.kind, v.category, v.description, user.id);
    const id = Number(r.lastInsertRowid);
    db.prepare("UPDATE assets SET status = 'maintenance' WHERE id = ?").run(v.asset_id);
    enqueue(db, {
      kind: 'maint',
      ref: `JOB-${id}`,
      key: `job-${id}-open`,
      assetId: v.asset_id,
      description: `${v.kind === 'service' ? 'Service' : 'Repair'} opened: ${v.description}`,
      data: { phase: 'open', description: v.description, category: v.category, lines: [], total: 0 },
    });
    audit(db, user, 'job.open', 'job', id, `${asset.plate}: ${v.description}`);
    return getJob(db, id);
  });
}

export function startJob(db, user, id, body) {
  const v = validate(body, { '?technician': 'string' });
  const j = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id);
  if (!j) throw notFound('Job not found');
  if (j.status !== 'open') throw bad('Only an open job can be started');
  db.prepare("UPDATE jobs SET status = 'in_progress', technician = COALESCE(?, technician) WHERE id = ?").run(v.technician ?? null, id);
  audit(db, user, 'job.start', 'job', id);
  return getJob(db, id);
}

export function closeJob(db, user, id, body) {
  const v = validate(body, { labour_cost: 'number', '?technician': 'string', '?meter_at_service': 'number' });
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (parts.length > 50) throw bad('Too many parts lines');
  const cleanParts = parts.map((p) => {
    const x = validate(p, { description: 'string', qty: 'number', unit_cost: 'number' });
    if (x.qty <= 0 || x.unit_cost < 0) throw bad('Part quantity must be above zero and cost cannot be negative');
    return x;
  });
  if (v.labour_cost < 0) throw bad('Labour cost cannot be negative');
  return tx(db, () => {
    const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!j) throw notFound('Job not found');
    if (j.status === 'closed') throw bad('This job is already closed');
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(j.asset_id);
    const partsCost = round2(cleanParts.reduce((s, p) => s + p.qty * p.unit_cost, 0));
    const total = round2(v.labour_cost + partsCost);
    const meterAt = v.meter_at_service ?? asset.meter;
    if (meterAt < asset.last_service_meter && j.kind === 'service') throw bad('Service meter is lower than the previous service');
    for (const p of cleanParts) db.prepare('INSERT INTO job_parts (job_id, description, qty, unit_cost) VALUES (?,?,?,?)').run(id, p.description, p.qty, p.unit_cost);
    db.prepare(
      `UPDATE jobs SET status = 'closed', closed_at = ?, labour_cost = ?, parts_cost = ?, total_cost = ?, meter_at_service = ?, technician = COALESCE(?, technician) WHERE id = ?`
    ).run(nowIso(), v.labour_cost, partsCost, total, meterAt, v.technician ?? null, id);
    const stillOpen = db.prepare("SELECT COUNT(*) n FROM jobs WHERE asset_id = ? AND status != 'closed'").get(j.asset_id).n;
    if (!stillOpen) db.prepare("UPDATE assets SET status = ? WHERE id = ?").run(asset.assigned_driver_id ? 'active' : 'idle', j.asset_id);
    if (j.kind === 'service') db.prepare('UPDATE assets SET last_service_meter = ?, last_service_at = ?, meter = MAX(meter, ?) WHERE id = ?').run(meterAt, nowIso().slice(0, 10), meterAt, j.asset_id);
    const lines = [
      { description: 'Labour', quantity: 1, unit: 'job', unitPrice: v.labour_cost, amount: v.labour_cost },
      ...cleanParts.map((p) => ({ description: p.description, quantity: p.qty, unit: 'pcs', unitPrice: p.unit_cost, amount: round2(p.qty * p.unit_cost) })),
    ];
    enqueue(db, {
      kind: 'maint',
      ref: `JOB-${id}`,
      key: `job-${id}-close`,
      assetId: j.asset_id,
      description: `${j.kind === 'service' ? 'Service' : 'Repair'} completed: ${j.description}`,
      amount: total,
      data: { phase: 'close', description: j.description, category: j.category, lines, total, technician: v.technician ?? j.technician },
    });
    audit(db, user, 'job.close', 'job', id, `KES ${total}`);
    return getJob(db, id);
  });
}

export function assetHistory(db, id) {
  getAsset(db, id);
  const jobs = db.prepare("SELECT id FROM jobs WHERE asset_id = ? ORDER BY id DESC LIMIT 100").all(id).map((r) => getJob(db, r.id));
  const fuel = listFuel(db, { assetId: id, limit: 50 });
  return { jobs, fuel };
}

/* ---------- reports ---------- */

function lastMonths(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(x.toISOString().slice(0, 7));
  }
  return out;
}

export function summary(db) {
  const fy = fyOf();
  const assets = listAssets(db);
  const counts = { total: assets.length, active: 0, idle: 0, maintenance: 0 };
  for (const a of assets) counts[a.status]++;
  const dueSoon = assets.filter((a) => ['overdue', 'soon'].includes(a.schedule.state)).sort((x, y) => x.schedule.remaining - y.schedule.remaining);
  const expiries = assets
    .flatMap((a) => [
      { asset_id: a.id, plate: a.plate, what: 'Registration', date: a.registration_expiry, ...a.registration },
      { asset_id: a.id, plate: a.plate, what: 'Insurance', date: a.insurance_expiry, ...a.insurance },
    ])
    .filter((e) => ['expired', 'soon'].includes(e.state))
    .sort((a, b) => a.days - b.days);

  const fuelFy = db.prepare("SELECT COALESCE(SUM(total),0) cost, COALESCE(SUM(litres),0) litres FROM fuel_logs WHERE status = 'approved' AND created_at >= ?").get(fy.start);
  const maintFy = db.prepare("SELECT COALESCE(SUM(total_cost),0) cost FROM jobs WHERE status = 'closed' AND closed_at >= ?").get(fy.start);
  const pendingFuel = db.prepare("SELECT COUNT(*) n FROM fuel_logs WHERE status = 'submitted'").get().n;
  const flaggedFuel = db.prepare("SELECT COUNT(*) n FROM fuel_logs WHERE status = 'submitted' AND ABS(COALESCE(variance_pct,0)) > 20").get().n;
  const openJobs = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status != 'closed'").get().n;

  const months = lastMonths(6);
  const since = `${months[0]}-01`;
  const fuelByMonth = Object.fromEntries(db.prepare("SELECT substr(created_at,1,7) m, SUM(total) c FROM fuel_logs WHERE status='approved' AND created_at >= ? GROUP BY m").all(since).map((r) => [r.m, r.c]));
  const maintByMonth = Object.fromEntries(db.prepare("SELECT substr(closed_at,1,7) m, SUM(total_cost) c FROM jobs WHERE status='closed' AND closed_at >= ? GROUP BY m").all(since).map((r) => [r.m, r.c]));
  const monthly = months.map((m) => ({ month: m, fuel: round2(fuelByMonth[m] || 0), maintenance: round2(maintByMonth[m] || 0) }));

  const byAsset = db
    .prepare(
      `SELECT a.id, a.plate, a.type, a.fuel_basis,
        COALESCE((SELECT SUM(total) FROM fuel_logs f WHERE f.asset_id = a.id AND f.status='approved' AND f.created_at >= ?),0) AS fuel_cost,
        COALESCE((SELECT SUM(litres) FROM fuel_logs f WHERE f.asset_id = a.id AND f.status='approved' AND f.created_at >= ?),0) AS litres,
        COALESCE((SELECT SUM(total_cost) FROM jobs j WHERE j.asset_id = a.id AND j.status='closed' AND j.closed_at >= ?),0) AS maint_cost
       FROM assets a WHERE a.status != 'retired'`
    )
    .all(fy.start, fy.start, fy.start)
    .map((r) => ({ ...r, total: round2(r.fuel_cost + r.maint_cost) }))
    .sort((a, b) => b.total - a.total);

  const budgetRows = db.prepare('SELECT vote, amount FROM budgets WHERE fy = ?').all(fy.label);
  const spent = { 'Fuel and lubricants': fuelFy.cost, 'Repairs and maintenance': maintFy.cost };
  const budgets = budgetRows.map((b) => ({ vote: b.vote, amount: b.amount, spent: round2(spent[b.vote] ?? 0), used_pct: b.amount ? round2(((spent[b.vote] ?? 0) / b.amount) * 100) : null }));

  return {
    fy: fy.label,
    counts,
    dueSoon,
    expiries,
    fuel: { cost: round2(fuelFy.cost), litres: round2(fuelFy.litres), pending: pendingFuel, flagged: flaggedFuel },
    maintenance: { cost: round2(maintFy.cost), open: openJobs },
    monthly,
    byAsset,
    budgets,
    dieselPrice: getSetting(db, 'diesel_price'),
  };
}
