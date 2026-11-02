import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, sendJson, readJson } from './util.js';
import { userFromRequest, requireRole } from './auth.js';
import { routes } from './routes.js';
import { handleMockErp, MOCK_BASE } from './erp/mockErp.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed');
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, 'Not found');
  let stat;
  try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Not found'); }
  if (!stat.isFile()) throw new HttpError(404, 'Not found');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

export function createApp(db) {
  return http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/healthz') {
        db.prepare('SELECT 1').get();
        return sendJson(res, 200, { ok: true });
      }
      if (pathname.startsWith(MOCK_BASE)) return await handleMockErp(db, req, res, pathname);

      if (pathname.startsWith('/api/')) {
        const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
        if (!route) {
          if (routes.some((r) => r.re.test(pathname))) throw new HttpError(405, 'Method not allowed');
          throw new HttpError(404, 'Not found');
        }
        // A custom header cannot be sent cross-site without a CORS preflight, which this server never allows.
        if (req.method !== 'GET' && req.headers['x-fleet-client'] !== '1') throw new HttpError(403, 'Missing X-Fleet-Client header');
        let user = null;
        if (route.roles) {
          user = userFromRequest(db, req);
          if (route.roles !== 'any') requireRole(user, route.roles);
          else requireRole(user, null);
          const open = ['/api/me', '/api/logout', '/api/change-password'];
          if (user.mustChangePassword && !open.includes(pathname)) throw new HttpError(403, 'Change your temporary password first', { mustChangePassword: true });
        }
        const params = {};
        const m = route.re.exec(pathname);
        route.keys.forEach((k, i) => (params[k] = m[i + 1]));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const out = await route.handler({ db, user, body, params, query: url.searchParams, req, res });
        return sendJson(res, 200, out);
      }
      return serveStatic(req, res, pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error('Unhandled error:', e);
      return sendJson(res, 500, { error: 'Something went wrong on the server' });
    }
  });
}
