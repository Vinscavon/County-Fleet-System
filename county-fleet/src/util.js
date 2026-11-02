import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, msg);

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > config.maxBody) throw new HttpError(413, 'Request body is too large');
    chunks.push(c);
  }
  if (!size) return {};
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Send JSON with Content-Type: application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('The request body is not valid JSON');
  }
}

/** Small validator: spec = { field: 'string' | 'number' | 'int' | 'date' | ['a','b'] (enum) , '?field': ... optional } */
export function validate(body, spec) {
  const out = {};
  for (const [rawKey, type] of Object.entries(spec)) {
    const optional = rawKey.startsWith('?');
    const key = optional ? rawKey.slice(1) : rawKey;
    const v = body?.[key];
    if (v === undefined || v === null || v === '') {
      if (optional) continue;
      throw bad(`${key} is required`);
    }
    if (type === 'string') {
      if (typeof v !== 'string') throw bad(`${key} must be text`);
      out[key] = v.trim().slice(0, 500);
    } else if (type === 'number' || type === 'int') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad(`${key} must be a number`);
      if (type === 'int' && !Number.isInteger(n)) throw bad(`${key} must be a whole number`);
      out[key] = n;
    } else if (type === 'date') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${key} must be a date like 2026-12-31`);
      out[key] = v;
    } else if (Array.isArray(type)) {
      if (!type.includes(v)) throw bad(`${key} must be one of: ${type.join(', ')}`);
      out[key] = v;
    }
  }
  return out;
}

export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const round2 = (n) => Math.round(n * 100) / 100;
