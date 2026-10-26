// Sign-in for the software provider's console: password plus a 6-digit authenticator code (TOTP, RFC 6238).

import { HttpError, forbidden, nowIso } from './http.js';
import { sha256Hex, verifyPassword } from './auth.js';

const IDLE_MINUTES = 30;
const MAX_HOURS = 8;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const STEP = 30; // seconds per code

const addMinutes = (iso, m) => new Date(Date.parse(iso) + m * 60e3).toISOString();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- authenticator codes ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Bytes(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
async function codeAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', base32Bytes(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, step);
  new DataView(msg).setUint32(0, Math.floor(step / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// The step the code belongs to (now, or one step either side for clock drift), or null.
export async function totpStep(secret, code, nowMs = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(nowMs / 1000 / STEP);
  for (const s of [now, now - 1, now + 1]) if ((await codeAt(secret, s)) === c) return s;
  return null;
}
export const otpauthUrl = (secret, username) =>
  `otpauth://totp/${encodeURIComponent('Rugged Customs:' + username)}?secret=${secret}&issuer=${encodeURIComponent('Rugged Customs')}&digits=6&period=${STEP}`;

// ---- audit ----

export const platformAudit = (db, adminId, action, companyId, summary, ip = null) =>
  db.prepare('INSERT INTO platform_audit (id, admin_id, action, company_id, summary, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), adminId, action, companyId, summary, ip);

// ---- sign in ----
// Returns { need: 'code' } when only the password was sent, { need: 'setup', secret, otpauth } when the
// authenticator is not yet set up (the next call with a code from it switches it on), or a session.
export async function platformLogin(db, username, password, code, ip) {
  const wrong = new HttpError(401, 'Wrong user name, password or code.');
  const a = await db.prepare('SELECT * FROM platform_admins WHERE username = ?').bind(username).first();
  if (!a) {
    await platformAudit(db, null, 'sign-in failed', null, `Unknown user ${username}`, ip).run();
    throw wrong;
  }
  const now = nowIso();
  if (a.locked_until && a.locked_until > now) throw new HttpError(423, `Too many wrong tries. Try again after ${LOCK_MINUTES} minutes.`);
  const failed = async (why) => {
    const failures = a.failed_attempts + 1;
    const lock = failures >= MAX_FAILURES ? addMinutes(now, LOCK_MINUTES) : null;
    await db.batch([
      db.prepare('UPDATE platform_admins SET failed_attempts = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failures, lock, a.id),
      platformAudit(db, a.id, 'sign-in failed', null, why + (lock ? ', locked' : ''), ip),
    ]);
    throw wrong;
  };
  if (!a.active || !(await verifyPassword(password, a.password_hash))) return failed(a.active ? 'wrong password' : 'switched off');

  if (!a.totp_enabled) {
    let secret = a.totp_secret;
    if (!secret) {
      secret = newTotpSecret();
      await db.prepare('UPDATE platform_admins SET totp_secret = ? WHERE id = ?').bind(secret, a.id).run();
      a.totp_secret = secret;
    }
    if (!code) return { need: 'setup', secret, otpauth: otpauthUrl(secret, a.username) };
  } else if (!code) return { need: 'code' };

  const step = await totpStep(a.totp_secret, code);
  if (step == null || step <= a.totp_last_step) return failed('wrong or reused code');

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = addMinutes(now, MAX_HOURS * 60);
  await db.batch([
    db.prepare('UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL, totp_enabled = 1, totp_last_step = ?, last_sign_in = ? WHERE id = ?').bind(step, now, a.id),
    db.prepare('INSERT INTO platform_sessions (token_hash, admin_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await sha256Hex(token), a.id, now, now, expires),
    platformAudit(db, a.id, 'sign-in', null, a.totp_enabled ? 'Signed in' : 'Signed in and set up the authenticator', ip),
  ]);
  return { token, expires_at: expires, must_change: !!a.must_change, admin: { id: a.id, name: a.name, username: a.username, role: a.role } };
}

export async function authenticatePlatform(db, request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Please sign in.');
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT s.last_seen, s.expires_at, a.id, a.name, a.username, a.role, a.active, a.must_change
       FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.token_hash = ?`
  ).bind(hash).first();
  const now = nowIso();
  if (!row || !row.active || row.expires_at <= now || addMinutes(row.last_seen, IDLE_MINUTES) <= now) {
    if (row) await db.prepare('DELETE FROM platform_sessions WHERE token_hash = ?').bind(hash).run();
    throw new HttpError(401, 'Your session has ended. Please sign in again.');
  }
  if (addMinutes(row.last_seen, 1) <= now) await db.prepare('UPDATE platform_sessions SET last_seen = ? WHERE token_hash = ?').bind(now, hash).run();
  return {
    token,
    ip: request.headers.get('cf-connecting-ip'),
    admin: { id: row.id, name: row.name, username: row.username, role: row.role },
    mustChange: !!row.must_change,
  };
}

export const requireOwner = (ctx) => {
  if (ctx.admin.role !== 'owner') throw forbidden('Only the owner admin can do this.');
};
