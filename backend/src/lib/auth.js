// Passwords, sessions and permissions.

import { HttpError, forbidden, nowIso } from './http.js';

const ITERATIONS = 100000; // the most PBKDF2 iterations Workers allow
const IDLE_MINUTES = 120;  // sign out after 2 hours without use
const MAX_HOURS = 12;      // and after 12 hours in any case
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export function checkPasswordRules(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must have letters and numbers.';
  return null;
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const addMinutes = (iso, m) => new Date(Date.parse(iso) + m * 60e3).toISOString();

// ---- sign in ----

export async function login(db, companyId, username, password, ip) {
  const fail = (detail, userId = null) =>
    db.prepare('INSERT INTO sign_ins (id, company_id, username, user_id, ok, detail, ip) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .bind(crypto.randomUUID(), companyId, username, userId, detail, ip).run();
  const wrong = new HttpError(401, 'Wrong user name or password.');

  const company = await db.prepare("SELECT id FROM companies WHERE id = ? AND status = 'Active'").bind(companyId).first();
  if (!company) throw wrong;
  const user = await db.prepare('SELECT * FROM users WHERE company_id = ? AND username = ?').bind(companyId, username).first();
  if (!user) {
    await fail('unknown user');
    throw wrong;
  }
  const now = nowIso();
  if (user.locked_until && user.locked_until > now) {
    await fail('locked', user.id);
    throw new HttpError(423, `Too many wrong passwords. Try again after ${LOCK_MINUTES} minutes, or ask the owner to unlock you.`);
  }
  if (!user.active) {
    await fail('inactive', user.id);
    throw wrong;
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    const failures = user.failed_attempts + 1;
    const lock = failures >= MAX_FAILURES ? addMinutes(now, LOCK_MINUTES) : null;
    await db.batch([
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failures, lock, user.id),
      db.prepare('INSERT INTO sign_ins (id, company_id, username, user_id, ok, detail, ip) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .bind(crypto.randomUUID(), companyId, username, user.id, lock ? 'wrong password, locked' : 'wrong password', ip),
    ]);
    throw wrong;
  }

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = addMinutes(now, MAX_HOURS * 60);
  await db.batch([
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(user.id),
    db.prepare('INSERT INTO sessions (token_hash, user_id, company_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), user.id, companyId, now, now, expires),
    db.prepare('INSERT INTO sign_ins (id, company_id, username, user_id, ok, detail, ip) VALUES (?, ?, ?, ?, 1, NULL, ?)')
      .bind(crypto.randomUUID(), companyId, username, user.id, ip),
  ]);
  return { token, expires_at: expires };
}

export async function logout(db, token) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

// Finds the signed-in user from the "Authorization: Bearer <token>" header.
export async function authenticate(db, request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Please sign in.');
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT s.last_seen, s.expires_at, u.id, u.company_id, u.name, u.username, u.active, u.person_id, u.branch_id,
            r.id AS role_id, r.name AS role_name, r.perms_json
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = ?`
  ).bind(hash).first();
  const now = nowIso();
  if (!row || !row.active || row.expires_at <= now || addMinutes(row.last_seen, IDLE_MINUTES) <= now) {
    if (row) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    throw new HttpError(401, 'Your session has ended. Please sign in again.');
  }
  // Touch the session at most once a minute to save writes.
  if (addMinutes(row.last_seen, 1) <= now) await db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(now, hash).run();
  return {
    token,
    user: { id: row.id, name: row.name, username: row.username, person_id: row.person_id, branch_id: row.branch_id },
    companyId: row.company_id,
    role: { id: row.role_id, name: row.role_name },
    perms: JSON.parse(row.perms_json || '{}'),
  };
}

// ---- permissions ----
// perms_json maps an area to 'view' or 'edit'. {"all":"edit"} is the owner.
// "scope":"own" limits a collection agent to the tickets assigned to them.

export const AREAS = ['dash', 'groups', 'members', 'enroll', 'auctions', 'payable', 'receipts', 'accounts', 'reports', 'staff', 'settings', 'cancelRc', 'del'];

const level = (perms, area) => perms.all || perms[area] || null;

export function can(ctx, area, need = 'view') {
  const l = level(ctx.perms, area);
  return need === 'view' ? l === 'view' || l === 'edit' : l === 'edit';
}

export function requirePerm(ctx, area, need = 'view') {
  if (!can(ctx, area, need)) throw forbidden();
}

export const ownTicketsOnly = (ctx) => ctx.perms.scope === 'own';

// The five roles from the requirements document.
export const DEFAULT_ROLES = [
  { name: 'Owner', is_system: 1, perms: { all: 'edit' } },
  {
    name: 'Manager',
    perms: { dash: 'edit', groups: 'edit', members: 'edit', enroll: 'edit', auctions: 'edit', payable: 'edit', receipts: 'edit', accounts: 'view', reports: 'view', cancelRc: 'edit' },
  },
  {
    name: 'Accountant',
    perms: { dash: 'view', groups: 'view', members: 'view', enroll: 'view', auctions: 'view', payable: 'edit', receipts: 'edit', accounts: 'edit', reports: 'view', cancelRc: 'edit' },
  },
  { name: 'Collection agent', perms: { dash: 'view', members: 'view', receipts: 'edit', scope: 'own' } },
  {
    name: 'Viewer',
    perms: { dash: 'view', groups: 'view', members: 'view', enroll: 'view', auctions: 'view', payable: 'view', receipts: 'view', accounts: 'view', reports: 'view' },
  },
];

// ---- member app ----
// Members sign in with their member number and a password the office issues. Sessions last
// longer than staff ones, since the app stays signed in on the member's own phone.

const MEMBER_IDLE_DAYS = 15;
const MEMBER_MAX_DAYS = 30;

// A 6-digit temporary password, shown once to the office.
export function tempPassword() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

export function checkMemberPassword(password, username) {
  if (typeof password !== 'string' || password.length < 6) return 'Password must be at least 6 characters.';
  if (/^(.)\1+$/.test(password)) return 'Password cannot be one character repeated.';
  if (['123456', '1234567', '12345678', '654321'].includes(password)) return 'This password is too easy to guess.';
  if (username && password.replace(/\D/g, '') === String(username).replace(/\D/g, '') && /^\d+$/.test(password)) return 'Password cannot be your member number.';
  return null;
}

// The member number from what the member types: "M00084", "m84" or "84".
export const memberNoOf = (username) => {
  const d = String(username || '').replace(/\D/g, '');
  return d ? Number(d) : null;
};

export async function memberLogin(db, companyId, username, password, ip) {
  const wrong = new HttpError(401, 'Wrong member number or password.');
  const no = memberNoOf(username);
  const company = await db.prepare("SELECT id FROM companies WHERE id = ? AND status = 'Active'").bind(companyId).first();
  if (!company || !no) throw wrong;
  const row = await db.prepare(
    `SELECT l.*, p.id AS pid FROM persons p JOIN member_logins l ON l.person_id = p.id
      WHERE p.company_id = ? AND p.member_no = ?`
  ).bind(companyId, no).first();
  const note = (ok, detail) => db.prepare('INSERT INTO sign_ins (id, company_id, username, user_id, ok, detail, ip) VALUES (?, ?, ?, NULL, ?, ?, ?)')
    .bind(crypto.randomUUID(), companyId, 'member:' + no, ok, detail, ip);
  if (!row) {
    await note(0, 'member app: no login').run();
    throw wrong;
  }
  const now = nowIso();
  if (row.locked_until && row.locked_until > now) {
    await note(0, 'member app: locked').run();
    throw new HttpError(423, `Too many wrong passwords. Try again after ${LOCK_MINUTES} minutes, or ask the office to reset your password.`);
  }
  if (!row.active) {
    await note(0, 'member app: switched off').run();
    throw new HttpError(403, 'Your app login is switched off. Please contact the office.');
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    const failures = row.failed_attempts + 1;
    const lock = failures >= MAX_FAILURES ? addMinutes(now, LOCK_MINUTES) : null;
    await db.batch([
      db.prepare('UPDATE member_logins SET failed_attempts = ?, locked_until = ? WHERE person_id = ?').bind(lock ? 0 : failures, lock, row.pid),
      note(0, lock ? 'member app: wrong password, locked' : 'member app: wrong password'),
    ]);
    throw wrong;
  }
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = addMinutes(now, MEMBER_MAX_DAYS * 24 * 60);
  await db.batch([
    db.prepare('UPDATE member_logins SET failed_attempts = 0, locked_until = NULL, last_sign_in = ? WHERE person_id = ?').bind(now, row.pid),
    db.prepare('INSERT INTO member_sessions (token_hash, person_id, company_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), row.pid, companyId, now, now, expires),
    note(1, 'member app'),
  ]);
  return { token, expires_at: expires, must_change: !!row.must_change };
}

export async function memberLogout(db, token) {
  await db.prepare('DELETE FROM member_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

// The signed-in member, from "Authorization: Bearer <token>". Staff tokens do not work here, and member tokens
// do not work on staff routes, since each looks only in its own session table.
export async function authenticateMember(db, request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Please sign in.');
  const hash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT s.last_seen, s.expires_at, s.company_id, p.id, p.name, p.member_no, l.active, l.must_change
       FROM member_sessions s JOIN persons p ON p.id = s.person_id JOIN member_logins l ON l.person_id = s.person_id
      WHERE s.token_hash = ?`
  ).bind(hash).first();
  const now = nowIso();
  if (!row || !row.active || row.expires_at <= now || addMinutes(row.last_seen, MEMBER_IDLE_DAYS * 24 * 60) <= now) {
    if (row) await db.prepare('DELETE FROM member_sessions WHERE token_hash = ?').bind(hash).run();
    throw new HttpError(401, 'Your session has ended. Please sign in again.');
  }
  if (addMinutes(row.last_seen, 1) <= now) await db.prepare('UPDATE member_sessions SET last_seen = ? WHERE token_hash = ?').bind(now, hash).run();
  return { token, member: { id: row.id, name: row.name, member_no: row.member_no }, companyId: row.company_id, mustChange: !!row.must_change };
}
