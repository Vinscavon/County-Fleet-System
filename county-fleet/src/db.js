import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','fleet_manager','workshop','finance','driver')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cost_centres (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS vendors (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS budgets (
  fy TEXT NOT NULL,
  vote TEXT NOT NULL,
  amount REAL NOT NULL,
  synced_at TEXT,
  PRIMARY KEY (fy, vote)
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('heavy','transport')),
  make_model TEXT NOT NULL DEFAULT '',
  year_made INTEGER,
  year_purchased INTEGER,
  county TEXT NOT NULL DEFAULT 'Uasin Gishu',
  erp_asset_no TEXT,
  cost_centre TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('active','idle','maintenance','retired')),
  fuel_basis TEXT NOT NULL DEFAULT 'km' CHECK (fuel_basis IN ('km','hrs')),
  fuel_rate REAL NOT NULL DEFAULT 0,
  meter REAL NOT NULL DEFAULT 0,
  service_interval REAL NOT NULL DEFAULT 0,
  last_service_meter REAL NOT NULL DEFAULT 0,
  last_service_at TEXT,
  assigned_driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  location TEXT NOT NULL DEFAULT '',
  registration_expiry TEXT,
  insurance_expiry TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fuel_logs (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  driver_id INTEGER REFERENCES users(id),
  litres REAL NOT NULL CHECK (litres > 0),
  unit_price REAL NOT NULL,
  total REAL NOT NULL,
  meter_reading REAL,
  expected_litres REAL,
  variance_pct REAL,
  cost_centre TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS fuel_asset ON fuel_logs(asset_id, created_at);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  kind TEXT NOT NULL CHECK (kind IN ('repair','service')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','closed')),
  opened_by INTEGER REFERENCES users(id),
  technician TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  labour_cost REAL NOT NULL DEFAULT 0,
  parts_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  meter_at_service REAL
);
CREATE TABLE IF NOT EXISTS job_parts (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fuel','maint','asset')),
  asset_id INTEGER REFERENCES assets(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','synced','failed','review')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  erp_reference TEXT,
  override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Demo ERP (only used when the built-in demo ERP is enabled)
CREATE TABLE IF NOT EXISTS mock_erp_documents (
  idempotency_key TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mock_erp_cost_centres (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0
);
`;
