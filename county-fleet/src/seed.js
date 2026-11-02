import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb, tx } from './db.js';
import { hashPassword, randomPassword } from './auth.js';
import { setSetting } from './settings.js';
import { seedMockErp, MOCK_BASE } from './erp/mockErp.js';
import { fyOf } from './services.js';
import { round2 } from './util.js';

const PEOPLE = [
  ['System Administrator', 'admin@fleet.local', 'admin'],
  ['Grace Chebet', 'manager@fleet.local', 'fleet_manager'],
  ['Peter Kiprono', 'workshop@fleet.local', 'workshop'],
  ['Faith Jepkemboi', 'finance@fleet.local', 'finance'],
  ['Daniel Kimutai', 'driver1@fleet.local', 'driver'],
  ['Joseph Rotich', 'driver2@fleet.local', 'driver'],
  ['Mary Jeptoo', 'driver3@fleet.local', 'driver'],
];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ymd = (d) => d.toISOString().slice(0, 10);
const inDays = (n) => ymd(new Date(Date.now() + n * 86400e3));

/** Creates the first users (random temporary passwords) and, in demo mode, a sample fleet. Does nothing if users exist. */
export function seed(db, { demo = config.seedDemoData, writeFile = true } = {}) {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return null;
  const people = demo ? PEOPLE : PEOPLE.slice(0, 1);
  const creds = [];
  tx(db, () => {
    const ins = db.prepare('INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?,?,?,?,1)');
    for (const [name, email, role] of people) {
      const pw = randomPassword();
      ins.run(name, email, hashPassword(pw), role);
      creds.push({ name, email, role, password: pw });
    }
    if (demo) seedDemo(db);
  });
  if (writeFile) {
    const file = path.join(path.dirname(config.dbFile), 'initial-credentials.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      'Temporary passwords. Each person must choose a new one at first sign-in. Delete this file after handing them out.\n\n' +
        creds.map((c) => `${c.role.padEnd(14)} ${c.email.padEnd(24)} ${c.password}`).join('\n') + '\n',
      { mode: 0o600 }
    );
    console.log(`First-run passwords written to ${file}`);
  }
  return creds;
}

function seedDemo(db) {
  const rand = mulberry32(2026);
  const fy = fyOf();
  setSetting(db, 'diesel_price', 195);
  setSetting(db, 'erp', {
    adapter: 'rest', profile: 'ifmis', base_url: `http://127.0.0.1:${config.port}${MOCK_BASE}`, auth: 'apikey', schedule: 'realtime',
    mapping: { fuel: 'Fuel and lubricants', maint: 'Repairs and maintenance', asset: 'Fixed assets' },
  });
  const cc = db.prepare('INSERT INTO cost_centres (code, name) VALUES (?,?)');
  [['ROADS-04', 'Roads maintenance'], ['WATER-02', 'Water services'], ['TRANSP-01', 'County transport pool']].forEach((r) => cc.run(...r));
  const bud = db.prepare('INSERT INTO budgets (fy, vote, amount) VALUES (?,?,?)');
  bud.run(fy.label, 'Fuel and lubricants', 22000000);
  bud.run(fy.label, 'Repairs and maintenance', 3500000);
  seedMockErp(db);

  const drivers = db.prepare("SELECT id FROM users WHERE role = 'driver' ORDER BY id").all().map((d) => d.id);
  const manager = db.prepare("SELECT id FROM users WHERE role = 'fleet_manager'").get().id;
  const workshop = db.prepare("SELECT id FROM users WHERE role = 'workshop'").get().id;

  // plate, type, category, make, made, bought, costcentre, basis, rate, meter, interval, lastService, location, driver, status, regDays, insDays
  const FLEET = [
    ['KDA 214B', 'Motor grader', 'heavy', 'CAT 140K', 2018, 2019, 'ROADS-04', 'hrs', 14, 5420, 250, 5190, 'Eldoret–Kapsabet road', 0, 'active', 210, 140],
    ['KDB 330C', 'Excavator', 'heavy', 'Komatsu PC200', 2017, 2018, 'ROADS-04', 'hrs', 16, 3180, 250, 2900, 'Moiben drainage works', 1, 'active', 95, 60],
    ['KDC 118D', 'Water drilling rig', 'heavy', 'Truck-mounted rig', 2019, 2020, 'WATER-02', 'hrs', 22, 1460, 200, 1300, 'Turbo borehole site', 2, 'active', 300, 18],
    ['GKB 502E', 'Tipper lorry', 'transport', 'Isuzu FVZ', 2016, 2017, 'TRANSP-01', 'km', 32, 128400, 10000, 120000, 'Eldoret depot', null, 'idle', 25, 200],
    ['GKB 611F', 'Water bowser', 'transport', 'Isuzu FTR', 2015, 2016, 'WATER-02', 'km', 30, 94250, 10000, 85000, 'Kesses', null, 'idle', -6, 120],
    ['GKC 077G', 'Wheel loader', 'heavy', 'CAT 950', 2014, 2015, 'ROADS-04', 'hrs', 12, 4010, 250, 3800, 'Eldoret depot', null, 'maintenance', 260, 260],
    ['GKC 245H', 'Road roller', 'heavy', 'Bomag BW211', 2013, 2015, 'ROADS-04', 'hrs', 8, 2290, 250, 2100, 'Soy road works', null, 'idle', 180, 180],
    ['KDD 901J', 'Pickup', 'transport', 'Toyota Hilux', 2021, 2021, 'TRANSP-01', 'km', 11, 61200, 5000, 57000, 'County HQ', null, 'idle', 330, 100],
  ];
  const insA = db.prepare(
    `INSERT INTO assets (plate,type,category,make_model,year_made,year_purchased,erp_asset_no,cost_centre,status,fuel_basis,fuel_rate,meter,service_interval,last_service_meter,last_service_at,assigned_driver_id,location,registration_expiry,insurance_expiry)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const assets = FLEET.map((f, i) => {
    const r = insA.run(f[0], f[1], f[2], f[3], f[4], f[5], `FA-${String(1001 + i)}`, f[6], f[14], f[7], f[8], f[9], f[10], f[11], inDays(-70 - i * 9), f[13] == null ? null : drivers[f[13]], f[12], inDays(f[15]), inDays(f[16]));
    return { id: Number(r.lastInsertRowid), plate: f[0], basis: f[7], rate: f[8], interval: f[10], f };
  });

  // Six months of approved fuel and closed jobs, so the reports have something to show.
  const insF = db.prepare("INSERT INTO fuel_logs (asset_id, driver_id, litres, unit_price, total, cost_centre, status, decided_by, decided_at, created_at) VALUES (?,?,?,?,?,?,'approved',?,?,?)");
  const insJ = db.prepare("INSERT INTO jobs (asset_id, kind, category, description, status, opened_by, technician, opened_at, closed_at, labour_cost, parts_cost, total_cost, meter_at_service) VALUES (?,?,?,?,'closed',?,?,?,?,?,?,?,?)");
  const insP = db.prepare('INSERT INTO job_parts (job_id, description, qty, unit_cost) VALUES (?,?,?,?)');
  const today = new Date();
  const PARTS = [['Engine oil 15W-40 (20 L)', 9800], ['Oil filter', 2600], ['Fuel filter', 3400], ['Hydraulic filter', 6800], ['Air filter', 4900], ['Hydraulic hose', 12500], ['Track pad set', 38000], ['Brake pads (set)', 14500]];
  const TECH = ['Peter Kiprono', 'Samuel Koech', 'Joel Mutai'];
  for (const a of assets) {
    const driver = a.f[13] == null ? drivers[0] : drivers[a.f[13]];
    for (let m = 5; m >= 0; m--) {
      const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - m, 1));
      const lastDay = m === 0 ? Math.max(0, today.getUTCDate() - 1) : 28;
      if (!lastDay) continue;
      const monthUse = a.basis === 'hrs' ? 70 + rand() * 60 : 2200 + rand() * 1800;
      const monthLitres = a.basis === 'hrs' ? monthUse * a.rate : (monthUse * a.rate) / 100;
      const fills = 3 + Math.floor(rand() * 2);
      for (let k = 0; k < fills; k++) {
        const day = Math.max(1, Math.min(lastDay, Math.round(((k + 0.5) / fills) * lastDay)));
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day, 8 + k, 10));
        const litres = round2((monthLitres / fills) * (0.93 + rand() * 0.16));
        const price = round2(184 + rand() * 11);
        insF.run(a.id, driver, litres, price, round2(litres * price), a.f[6], manager, d.toISOString().replace('T', ' ').slice(0, 19), d.toISOString().replace('T', ' ').slice(0, 19));
      }
      if (rand() < 0.55) {
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(lastDay, 3 + Math.floor(rand() * 20)), 10));
        const stamp = d.toISOString().replace('T', ' ').slice(0, 19);
        const service = rand() < 0.6;
        const picks = [PARTS[Math.floor(rand() * PARTS.length)], PARTS[Math.floor(rand() * PARTS.length)]];
        const parts = picks.map((p) => ({ description: p[0], qty: 1 + Math.floor(rand() * 2), unit_cost: p[1] }));
        const partsCost = round2(parts.reduce((s, p) => s + p.qty * p.unit_cost, 0));
        const labour = Math.round((6000 + rand() * 14000) / 500) * 500;
        const jr = insJ.run(a.id, service ? 'service' : 'repair', service ? 'Routine service' : 'Hydraulics', service ? 'Routine service and filter change' : 'Leak repair and pressure test', workshop, TECH[Math.floor(rand() * 3)], stamp, stamp, labour, partsCost, round2(labour + partsCost), a.f[11]);
        for (const p of parts) insP.run(jr.lastInsertRowid, p.description, p.qty, p.unit_cost);
      }
    }
  }

  // A few things waiting for a person to act on, so the demo starts with real work in it.
  const grader = assets[0];
  const rig = assets[2];
  insF2(db, grader.id, drivers[0], 410, 195, 280, grader.f[6]); // far above expected: flagged
  insF2(db, rig.id, drivers[2], 160, 195, 158, rig.f[6]);
  const loader = assets[5];
  db.prepare("INSERT INTO jobs (asset_id, kind, category, description, status, opened_by, technician) VALUES (?,?,?,?,'in_progress',?,?)").run(loader.id, 'repair', 'Hydraulics', 'Boom cylinder leaking oil', manager, 'Peter Kiprono');
}

function insF2(db, assetId, driverId, litres, price, expected, costCentre) {
  const variance = round2(((litres - expected) / expected) * 100);
  db.prepare(
    `INSERT INTO fuel_logs (asset_id, driver_id, litres, unit_price, total, expected_litres, variance_pct, cost_centre, status) VALUES (?,?,?,?,?,?,?,?, 'submitted')`
  ).run(assetId, driverId, litres, price, round2(litres * price), expected, variance, costCentre);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const db = openDb();
  const r = seed(db);
  console.log(r ? 'Database seeded.' : 'Users already exist, nothing to do.');
}
