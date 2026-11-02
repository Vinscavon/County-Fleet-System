import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const config = {
  root,
  port: Number(env.PORT) || 3000,
  dbFile: env.DB_FILE || path.join(root, 'data', 'fleet.db'),
  publicDir: path.join(root, 'public'),
  exportDir: env.ERP_EXPORT_DIR || path.join(root, 'data', 'erp-export'),
  importDir: env.ERP_IMPORT_DIR || path.join(root, 'data', 'erp-import'),
  production: env.NODE_ENV === 'production',
  cookieSecure: env.COOKIE_SECURE === '1',
  sessionHours: Number(env.SESSION_HOURS) || 12,
  maxBody: 1_000_000,
  // Secrets come from the environment only. They are never stored in the database or returned by the API.
  erp: {
    apiKey: env.ERP_API_KEY || '',
    clientId: env.ERP_CLIENT_ID || '',
    clientSecret: env.ERP_CLIENT_SECRET || '',
    tokenUrl: env.ERP_TOKEN_URL || '',
  },
  demoErp: env.ENABLE_DEMO_ERP ? env.ENABLE_DEMO_ERP === '1' : env.NODE_ENV !== 'production',
  demoErpKey: env.DEMO_ERP_KEY || 'demo-erp-key',
  seedDemoData: env.SEED_DEMO_DATA ? env.SEED_DEMO_DATA === '1' : env.NODE_ENV !== 'production',
  // Outbox behaviour
  syncIntervalMs: Number(env.SYNC_INTERVAL_MS) || 5000,
  maxAttempts: Number(env.ERP_MAX_ATTEMPTS) || 5,
  backoffBaseSeconds: Number(env.ERP_BACKOFF_SECONDS) || 30,
};
