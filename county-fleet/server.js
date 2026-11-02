import { config } from './src/config.js';
import { openDb } from './src/db.js';
import { seed } from './src/seed.js';
import { seedMockErp } from './src/erp/mockErp.js';
import { startWorker } from './src/erp/outbox.js';
import { createApp } from './src/app.js';

const db = openDb();
seed(db);
if (config.demoErp) seedMockErp(db);
const stopWorker = startWorker(db);
const server = createApp(db);

server.listen(config.port, () => {
  console.log(`County Fleet running on http://localhost:${config.port}`);
  if (config.demoErp) console.log('Demo ERP is switched on (not for production).');
  if (config.production && !config.cookieSecure) console.warn('Warning: set COOKIE_SECURE=1 when serving over HTTPS.');
});

const shutdown = () => {
  stopWorker();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
