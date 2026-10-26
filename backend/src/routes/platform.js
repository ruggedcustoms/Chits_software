// The software provider's console (Rugged Customs): companies, licences, branding and the provider's own admins.
// It sees counts and licence details, never a company's members, receipts or accounts.

import { bad, conflict, date, forbidden, int, json, newId, notFound, nowIso, readBody, str, todayIst } from '../lib/http.js';
import { checkPasswordRules, hashPassword, sha256Hex, verifyPassword } from '../lib/auth.js';
import { auditStatement } from '../lib/books.js';
import { cleanCode, companyStatements, tempStaffPassword } from '../lib/company.js';
import { licenceOf } from '../lib/licence.js';
import { platformAudit, platformLogin, requireOwner } from '../lib/platform.js';

const parse = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};
// Every console request except me, password and sign-out needs the admin's own password set first.
const ready = (h) => (args) => {
  if (args.ctx.mustChange) throw forbidden('Please set your own password first.');
  return h(args);
};
const STATUSES = ['Active', 'Suspended', 'Closed'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function brandOf(b, old = {}) {
  if (b == null) return old;
  if (typeof b !== 'object' || Array.isArray(b)) throw bad('brand must be an object.');
  const out = { ...old };
  if ('logo' in b) {
    if (b.logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo)) throw bad('The logo must be a PNG, JPEG or WebP image.');
    if (b.logo && b.logo.length > 400000) throw bad('The logo is too large. Use an image under 300 KB.');
    out.logo = b.logo || null;
  }
  for (const k of ['color', 'accent']) {
    if (k in b) {
      if (b[k] && !COLOR_RE.test(b[k])) throw bad(`${k} must be a colour like #0A86D0.`);
      out[k] = b[k] || null;
    }
  }
  if ('website' in b) {
    if (b.website && !/^https?:\/\/[^\s]+$/.test(b.website)) throw bad('Website must start with http:// or https://');
    out.website = b.website || null;
  }
  if ('display_name' in b) out.display_name = b.display_name ? String(b.display_name).slice(0, 120) : null;
  return out;
}

const graceOf = (b) => int(b, 'grace_days', { min: 0, max: 60, label: 'read-only days after expiry' });

// ---- first admin, sign in and out ----

// Creates an owner admin. Needs the SETUP_KEY secret, like company setup.
async function setup({ request, env }) {
  const key = request.headers.get('x-setup-key') || '';
  if (!env.SETUP_KEY || key !== env.SETUP_KEY) throw forbidden('Setup key is missing or wrong.');
  const b = await readBody(request);
  const name = str(b, 'name', { required: true });
  const username = str(b, 'username', { required: true, max: 40, label: 'user name' }).toLowerCase();
  const pwErr = checkPasswordRules(b.password);
  if (pwErr) throw bad(pwErr);
  if (await env.DB.prepare('SELECT 1 FROM platform_admins WHERE username = ?').bind(username).first()) throw conflict('This user name is taken.');
  const id = newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO platform_admins (id, name, username, password_hash, role, must_change) VALUES (?, ?, ?, ?, 'owner', 0)").bind(id, name, username, await hashPassword(b.password)),
    platformAudit(env.DB, null, 'create admin', null, `Owner admin ${username} created with the setup key`, request.headers.get('cf-connecting-ip')),
  ]);
  return json({ id, username }, 201);
}

async function signIn({ request, env }) {
  const b = await readBody(request);
  const username = str(b, 'username', { required: true, label: 'user name' }).toLowerCase();
  if (typeof b.password !== 'string' || !b.password) throw bad('Enter the password.');
  return json(await platformLogin(env.DB, username, b.password, str(b, 'code', { max: 10 }), request.headers.get('cf-connecting-ip')));
}

async function signOut({ env, ctx }) {
  await env.DB.prepare('DELETE FROM platform_sessions WHERE token_hash = ?').bind(await sha256Hex(ctx.token)).run();
  return json({ ok: true });
}

async function me({ ctx }) {
  return json({ admin: ctx.admin, must_change: ctx.mustChange });
}

async function changePassword({ request, env, ctx }) {
  const b = await readBody(request);
  const db = env.DB;
  const a = await db.prepare('SELECT password_hash FROM platform_admins WHERE id = ?').bind(ctx.admin.id).first();
  if (typeof b.current_password !== 'string' || !(await verifyPassword(b.current_password, a.password_hash))) throw bad('Your current password is wrong.');
  const pwErr = checkPasswordRules(b.new_password);
  if (pwErr) throw bad(pwErr);
  if (b.new_password === b.current_password) throw bad('Choose a new password, different from the current one.');
  await db.batch([
    db.prepare('UPDATE platform_admins SET password_hash = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(b.new_password), ctx.admin.id),
    db.prepare('DELETE FROM platform_sessions WHERE admin_id = ? AND token_hash != ?').bind(ctx.admin.id, await sha256Hex(ctx.token)),
    platformAudit(db, ctx.admin.id, 'password', null, 'Changed own password', ctx.ip),
  ]);
  return json({ ok: true });
}

// ---- companies ----

async function listCompanies({ env }) {
  const monthStart = todayIst().slice(0, 8) + '01';
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.code, c.name, c.owner_name, c.phone, c.email, c.city, c.state, c.plan, c.valid_till, c.grace_days, c.status, c.brand_json, c.created_at,
            (SELECT COUNT(*) FROM chit_groups g WHERE g.company_id = c.id) AS groups,
            (SELECT COUNT(*) FROM enrollments e WHERE e.company_id = c.id AND e.status = 'Active' AND e.is_company = 0) AS tickets,
            (SELECT COUNT(*) FROM persons p WHERE p.company_id = c.id) AS people,
            (SELECT COUNT(*) FROM receipts r WHERE r.company_id = c.id AND r.cancelled = 0 AND r.receipt_date >= ?) AS receipts_this_month,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS staff,
            (SELECT COUNT(*) FROM member_logins l WHERE l.company_id = c.id) AS member_logins,
            (SELECT MAX(at) FROM sign_ins s WHERE s.company_id = c.id AND s.ok = 1) AS last_sign_in
       FROM companies c ORDER BY c.name`
  ).bind(monthStart).all();
  return json(results.map((c) => ({ ...c, brand: parse(c.brand_json), brand_json: undefined, licence: licenceOf(c) })));
}

async function createCompany({ request, env, ctx }) {
  requireOwner(ctx);
  const b = await readBody(request);
  const db = env.DB;
  const code = cleanCode(b.code);
  if (!code) throw bad('Enter a short company code, for example "mrj". It goes in the links on the company\'s website.');
  if (await db.prepare('SELECT 1 FROM companies WHERE code = ?').bind(code).first()) throw conflict(`The code "${code}" is already used by another company.`);
  const password = tempStaffPassword();
  const c = {
    name: str(b, 'name', { required: true, label: 'company name' }),
    owner_name: str(b, 'owner_name', { required: true, label: "owner's name" }),
    username: (str(b, 'username', { max: 40, label: 'owner user name' }) || 'owner').toLowerCase(),
    password, must_change: true, code,
    phone: str(b, 'phone', { max: 20 }), email: str(b, 'email'), city: str(b, 'city'), state: str(b, 'state'),
    plan: str(b, 'plan', { max: 40 }) || 'Standard', valid_till: date(b, 'valid_till', { label: 'licence valid till' }),
    grace_days: graceOf(b) ?? 15, brand: brandOf(b.brand),
  };
  const { stmts, companyId } = await companyStatements(db, c);
  await db.batch([...stmts, platformAudit(db, ctx.admin.id, 'create company', companyId, `Company ${c.name} (${code}) created; owner login ${c.username}`, ctx.ip)]);
  return json({ company_id: companyId, code, username: c.username, password }, 201);
}

async function updateCompany({ request, env, ctx, params }) {
  requireOwner(ctx);
  const db = env.DB;
  const old = await db.prepare('SELECT * FROM companies WHERE id = ?').bind(params.id).first();
  if (!old) throw notFound('Company');
  const b = await readBody(request);
  const sets = [];
  const vals = [];
  const changes = [];
  const set = (col, v, label) => {
    if (v === undefined || v === old[col]) return;
    sets.push(`${col} = ?`); vals.push(v); changes.push(`${label} ${v ?? 'none'}`);
  };
  if ('name' in b) set('name', str(b, 'name', { required: true, label: 'company name' }), 'name');
  if ('code' in b) {
    const code = cleanCode(b.code);
    if (!code) throw bad('A company needs a code.');
    if (code !== old.code && (await db.prepare('SELECT 1 FROM companies WHERE code = ? AND id != ?').bind(code, old.id).first())) throw conflict(`The code "${code}" is already used by another company.`);
    set('code', code, 'code');
  }
  for (const [k, label, max] of [['owner_name', 'owner', 200], ['phone', 'phone', 20], ['email', 'email', 200], ['city', 'city', 200], ['state', 'state', 200], ['plan', 'plan', 40]]) {
    if (k in b) set(k, str(b, k, { max }), label);
  }
  if ('valid_till' in b) set('valid_till', date(b, 'valid_till', { label: 'licence valid till' }), 'valid till');
  if ('grace_days' in b) set('grace_days', graceOf(b) ?? 15, 'read-only days');
  if ('status' in b) {
    if (!STATUSES.includes(b.status)) throw bad(`Status must be one of: ${STATUSES.join(', ')}.`);
    set('status', b.status, 'status');
  }
  if ('brand' in b) {
    const nb = JSON.stringify(brandOf(b.brand, parse(old.brand_json)));
    if (nb !== old.brand_json) { sets.push('brand_json = ?'); vals.push(nb); changes.push('branding'); }
  }
  if (!sets.length) return json({ ok: true, changes: [] });
  await db.batch([
    db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, old.id),
    platformAudit(db, ctx.admin.id, 'update company', old.id, `${old.name}: ${changes.join(', ')}`, ctx.ip),
  ]);
  return json({ ok: true, changes });
}

// A new temporary password for the company's owner login (also unlocks it). Owner and support may do this.
async function resetOwner({ env, ctx, params }) {
  const db = env.DB;
  const co = await db.prepare('SELECT id, name FROM companies WHERE id = ?').bind(params.id).first();
  if (!co) throw notFound('Company');
  const owner = await db.prepare(
    `SELECT u.id, u.username FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND r.is_system = 1 ORDER BY u.created_at LIMIT 1`
  ).bind(co.id).first();
  if (!owner) throw notFound('Owner login');
  const password = tempStaffPassword();
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, must_change = 1, active = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(await hashPassword(password), owner.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(owner.id),
    auditStatement(db, { companyId: co.id, user: null }, 'update', 'users', owner.id, `Owner login ${owner.username}: password reset by the software provider`),
    platformAudit(db, ctx.admin.id, 'reset owner password', co.id, `${co.name}: owner login ${owner.username} given a new temporary password`, ctx.ip),
  ]);
  return json({ username: owner.username, password });
}

// ---- the provider's own admins ----

async function listAdmins({ env, ctx }) {
  requireOwner(ctx);
  const { results } = await env.DB.prepare(
    'SELECT id, name, username, role, active, totp_enabled, must_change, last_sign_in, locked_until, created_at FROM platform_admins ORDER BY name'
  ).all();
  const now = nowIso();
  return json(results.map((a) => ({ ...a, locked: !!(a.locked_until && a.locked_until > now), locked_until: undefined })));
}

async function createAdmin({ request, env, ctx }) {
  requireOwner(ctx);
  const b = await readBody(request);
  const db = env.DB;
  const name = str(b, 'name', { required: true });
  const username = str(b, 'username', { required: true, max: 40, label: 'user name' }).toLowerCase();
  const role = b.role === 'owner' ? 'owner' : 'support';
  if (await db.prepare('SELECT 1 FROM platform_admins WHERE username = ?').bind(username).first()) throw conflict('This user name is taken.');
  const password = tempStaffPassword();
  const id = newId();
  await db.batch([
    db.prepare('INSERT INTO platform_admins (id, name, username, password_hash, role, must_change) VALUES (?, ?, ?, ?, ?, 1)').bind(id, name, username, await hashPassword(password), role),
    platformAudit(db, ctx.admin.id, 'create admin', null, `${role === 'owner' ? 'Owner' : 'Support'} admin ${username} (${name}) created`, ctx.ip),
  ]);
  return json({ id, username, role, password }, 201);
}

async function updateAdmin({ request, env, ctx, params }) {
  requireOwner(ctx);
  const db = env.DB;
  const a = await db.prepare('SELECT * FROM platform_admins WHERE id = ?').bind(params.id).first();
  if (!a) throw notFound('Admin');
  const b = await readBody(request);
  const self = a.id === ctx.admin.id;
  const sets = [];
  const vals = [];
  const changes = [];
  let password;
  if (b.active != null) {
    if (self && !b.active) throw conflict('You cannot switch off your own login.');
    sets.push('active = ?'); vals.push(b.active ? 1 : 0); changes.push(b.active ? 'switched on' : 'switched off');
  }
  if (b.role) {
    if (self) throw conflict('You cannot change your own role.');
    if (!['owner', 'support'].includes(b.role)) throw bad('Role must be owner or support.');
    sets.push('role = ?'); vals.push(b.role); changes.push('role ' + b.role);
  }
  if (b.reset_password) {
    password = tempStaffPassword();
    sets.push('password_hash = ?', 'must_change = 1', 'failed_attempts = 0', 'locked_until = NULL'); vals.push(await hashPassword(password)); changes.push('password reset');
  }
  if (b.reset_2fa) { sets.push('totp_enabled = 0', 'totp_secret = NULL', 'totp_last_step = 0'); changes.push('authenticator reset'); }
  if (b.unlock) { sets.push('failed_attempts = 0', 'locked_until = NULL'); changes.push('unlocked'); }
  if (!sets.length) throw bad('Nothing to change.');
  const stmts = [
    db.prepare(`UPDATE platform_admins SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, a.id),
    platformAudit(db, ctx.admin.id, 'update admin', null, `Admin ${a.username}: ${changes.join(', ')}`, ctx.ip),
  ];
  if (!self && (b.active === false || b.reset_password || b.reset_2fa)) stmts.push(db.prepare('DELETE FROM platform_sessions WHERE admin_id = ?').bind(a.id));
  await db.batch(stmts);
  return json({ ok: true, changes, ...(password ? { password } : {}) });
}

async function auditLog({ env, query }) {
  const limit = Math.min(Number(query.get('limit')) || 200, 1000);
  const { results } = await env.DB.prepare(
    `SELECT l.at, a.name AS admin, l.action, c.name AS company, l.summary, l.ip FROM platform_audit l
       LEFT JOIN platform_admins a ON a.id = l.admin_id LEFT JOIN companies c ON c.id = l.company_id ORDER BY l.at DESC LIMIT ?`
  ).bind(limit).all();
  return json(results);
}

const P = { platform: true };
export const platformRoutes = [
  ['POST', '/api/platform/setup', setup, { public: true }],
  ['POST', '/api/platform/login', signIn, { public: true }],
  ['POST', '/api/platform/logout', signOut, P],
  ['GET', '/api/platform/me', me, P],
  ['POST', '/api/platform/password', changePassword, P],
  ['GET', '/api/platform/companies', ready(listCompanies), P],
  ['POST', '/api/platform/companies', ready(createCompany), P],
  ['PATCH', '/api/platform/companies/:id', ready(updateCompany), P],
  ['POST', '/api/platform/companies/:id/reset-owner', ready(resetOwner), P],
  ['GET', '/api/platform/admins', ready(listAdmins), P],
  ['POST', '/api/platform/admins', ready(createAdmin), P],
  ['PATCH', '/api/platform/admins/:id', ready(updateAdmin), P],
  ['GET', '/api/platform/audit', ready(auditLog), P],
];
