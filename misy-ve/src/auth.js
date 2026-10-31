import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const COOKIE_NAME = 'misyve_sid';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = await scryptAsync(password, Buffer.from(saltB64, 'base64'), key.length);
  return timingSafeEqual(test, key);
}

const sha = (t) => createHash('sha256').update(t).digest('hex');

export function createSession(db, userId, days) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    sha(token), userId, new Date(now).toISOString(), new Date(now + days * 86_400_000).toISOString(),
  );
  return token;
}

export function findSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).get(sha(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function destroyOtherSessions(db, userId, keepToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(keepToken || ''));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { days, secure }) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${days * 86400}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure }) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
