import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError, bad, forbidden } from './util.js';

const SCRYPT = { N: 16384, r: 8, p: 1 };
export const ROLES = ['admin', 'fleet_manager', 'workshop', 'finance', 'driver'];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw bad('Password must be at least 10 characters');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw bad('Password must contain letters and numbers');
}

export function randomPassword() {
  return crypto.randomBytes(9).toString('base64url') + '7a';
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, exp);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return token;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`];
  if (config.cookieSecure) flags.push('Secure');
  return `sid=${encodeURIComponent(token)}; ${flags.join('; ')}`;
}

export function userFromRequest(db, req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.must_change_password, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    )
    .get(sha(token));
  if (!row || !row.active || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, mustChangePassword: !!row.must_change_password, token };
}

export function requireRole(user, roles) {
  if (!user) throw new HttpError(401, 'Sign in to continue');
  if (roles && roles.length && user.role !== 'admin' && !roles.includes(user.role)) throw forbidden();
}

/* Login throttling: 5 failed attempts per email+address locks sign-in for 15 minutes. */
const attempts = new Map();
export function checkLoginAllowed(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
}
export function recordLoginFailure(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5) { a.until = Date.now() + 15 * 60e3; a.n = 0; }
  attempts.set(key, a);
}
export function clearLoginFailures(key) { attempts.delete(key); }
