// First-time setup, sign in and out, and staff logins.

import { bad, conflict, forbidden, json, newId, notFound, readBody, str, todayIst } from '../lib/http.js';
import { DEFAULT_ROLES, checkPasswordRules, hashPassword, login, logout, requirePerm } from '../lib/auth.js';
import { auditStatement, chartStatements } from '../lib/books.js';

// Creates a company with its roles, chart of accounts and owner login.
// Needs the SETUP_KEY secret (set with `wrangler secret put SETUP_KEY`), so the public cannot create companies.
async function setup({ request, env }) {
  const key = request.headers.get('x-setup-key') || '';
  if (!env.SETUP_KEY || key !== env.SETUP_KEY) throw forbidden('Setup key is missing or wrong.');
  const b = await readBody(request);
  const companyName = str(b, 'company_name', { required: true, label: 'company name' });
  const adminName = str(b, 'admin_name', { required: true, label: "owner's name" });
  const username = str(b, 'username', { required: true, max: 40, label: 'user name' });
  const pwErr = checkPasswordRules(b.password);
  if (pwErr) throw bad(pwErr);

  const db = env.DB;
  const companyId = newId();
  const branchId = newId();
  const userId = newId();
  const roles = DEFAULT_ROLES.map((r) => ({ ...r, id: newId() }));
  const ctx = { companyId, user: { id: userId } };
  await db.batch([
    db.prepare('INSERT INTO companies (id, name, owner_name, phone, email, city, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(companyId, companyName, adminName, str(b, 'phone'), str(b, 'email'), str(b, 'city'), str(b, 'state')),
    db.prepare('INSERT INTO branches (id, company_id, name) VALUES (?, ?, ?)').bind(branchId, companyId, 'Main branch'),
    ...roles.map((r) => db.prepare('INSERT INTO roles (id, company_id, name, is_system, perms_json) VALUES (?, ?, ?, ?, ?)')
      .bind(r.id, companyId, r.name, r.is_system || 0, JSON.stringify(r.perms))),
    ...chartStatements(db, companyId),
    db.prepare('INSERT INTO users (id, company_id, role_id, name, username, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, companyId, roles[0].id, adminName, username, await hashPassword(b.password)),
    auditStatement(db, ctx, 'create', 'companies', companyId, `Company ${companyName} set up with owner login ${username}`),
  ]);
  return json({ company_id: companyId, branch_id: branchId, owner_user_id: userId, created_on: todayIst() }, 201);
}

async function signIn({ request, env }) {
  const b = await readBody(request);
  const username = str(b, 'username', { required: true, label: 'user name' });
  if (typeof b.password !== 'string' || !b.password) throw bad('Enter the password.');
  let companyId = str(b, 'company_id');
  if (!companyId) {
    // With only one company in the database, the company need not be given.
    const { results } = await env.DB.prepare('SELECT id FROM companies LIMIT 2').all();
    if (results.length !== 1) throw bad('Enter the company code.');
    companyId = results[0].id;
  }
  const ip = request.headers.get('cf-connecting-ip');
  return json(await login(env.DB, companyId, username, b.password, ip));
}

async function signOut({ env, ctx }) {
  await logout(env.DB, ctx.token);
  return json({ ok: true });
}

async function me({ env, ctx }) {
  const company = await env.DB.prepare('SELECT id, name, member_prefix FROM companies WHERE id = ?').bind(ctx.companyId).first();
  return json({ user: ctx.user, role: ctx.role, perms: ctx.perms, company });
}

// ---- staff ----

async function listUsers({ env, ctx }) {
  requirePerm(ctx, 'staff');
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.mobile, u.email, u.active, u.person_id, u.branch_id, u.locked_until, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? ORDER BY u.name`
  ).bind(ctx.companyId).all();
  return json(results);
}

async function listRoles({ env, ctx }) {
  requirePerm(ctx, 'staff');
  const { results } = await env.DB.prepare('SELECT id, name, is_system, perms_json FROM roles WHERE company_id = ? ORDER BY name').bind(ctx.companyId).all();
  return json(results.map((r) => ({ ...r, perms: JSON.parse(r.perms_json), perms_json: undefined })));
}

async function findRole(db, companyId, b) {
  const roleId = str(b, 'role_id');
  const roleName = str(b, 'role');
  const role = roleId
    ? await db.prepare('SELECT id, name FROM roles WHERE company_id = ? AND id = ?').bind(companyId, roleId).first()
    : roleName
      ? await db.prepare('SELECT id, name FROM roles WHERE company_id = ? AND name = ?').bind(companyId, roleName).first()
      : null;
  if (!role) throw bad('Choose a role.');
  return role;
}

async function createUser({ request, env, ctx }) {
  requirePerm(ctx, 'staff', 'edit');
  const b = await readBody(request);
  const db = env.DB;
  const name = str(b, 'name', { required: true });
  const username = str(b, 'username', { required: true, max: 40, label: 'user name' });
  const pwErr = checkPasswordRules(b.password);
  if (pwErr) throw bad(pwErr);
  const role = await findRole(db, ctx.companyId, b);
  const personId = str(b, 'person_id');
  if (personId && !(await db.prepare('SELECT 1 FROM persons WHERE company_id = ? AND id = ?').bind(ctx.companyId, personId).first())) throw notFound('Person');
  if (role.name === 'Collection agent' && !personId) throw bad('A collection agent login must be linked to the agent (person_id).');
  const id = newId();
  await db.batch([
    db.prepare('INSERT INTO users (id, company_id, role_id, person_id, name, username, password_hash, mobile, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, ctx.companyId, role.id, personId, name, username, await hashPassword(b.password), str(b, 'mobile'), str(b, 'email')),
    auditStatement(db, ctx, 'create', 'users', id, `Login ${username} (${role.name}) created for ${name}`),
  ]);
  return json({ id, username, role: role.name }, 201);
}

async function updateUser({ request, env, ctx, params }) {
  requirePerm(ctx, 'staff', 'edit');
  const db = env.DB;
  const user = await db.prepare('SELECT u.*, r.is_system FROM users u JOIN roles r ON r.id = u.role_id WHERE u.company_id = ? AND u.id = ?').bind(ctx.companyId, params.id).first();
  if (!user) throw notFound('User');
  const b = await readBody(request);
  const sets = [];
  const vals = [];
  const changes = [];
  if (b.active != null) {
    if (!b.active && user.id === ctx.user.id) throw conflict('You cannot switch off your own login.');
    sets.push('active = ?'); vals.push(b.active ? 1 : 0); changes.push(b.active ? 'switched on' : 'switched off');
  }
  if (b.role_id || b.role) {
    const role = await findRole(db, ctx.companyId, b);
    if (user.id === ctx.user.id && role.id !== user.role_id) throw conflict('You cannot change your own role.');
    sets.push('role_id = ?'); vals.push(role.id); changes.push(`role ${role.name}`);
  }
  if (b.password != null) {
    const pwErr = checkPasswordRules(b.password);
    if (pwErr) throw bad(pwErr);
    sets.push('password_hash = ?'); vals.push(await hashPassword(b.password)); changes.push('password reset');
  }
  if (b.unlock) { sets.push('failed_attempts = 0', 'locked_until = NULL'); changes.push('unlocked'); }
  if (!sets.length) throw bad('Nothing to change.');
  const stmts = [
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, user.id),
    auditStatement(db, ctx, 'update', 'users', user.id, `Login ${user.username}: ${changes.join(', ')}`),
  ];
  // A switched-off login or a new password ends the user's open sessions.
  if (b.active === false || b.active === 0 || b.password != null) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id));
  await db.batch(stmts);
  return json({ ok: true, changes });
}

async function signIns({ env, ctx, query }) {
  requirePerm(ctx, 'staff');
  const limit = Math.min(Number(query.get('limit')) || 100, 500);
  const { results } = await env.DB.prepare('SELECT username, ok, detail, ip, at FROM sign_ins WHERE company_id = ? ORDER BY at DESC LIMIT ?').bind(ctx.companyId, limit).all();
  return json(results);
}

export const authRoutes = [
  ['POST', '/api/setup', setup, { public: true }],
  ['POST', '/api/auth/login', signIn, { public: true }],
  ['POST', '/api/auth/logout', signOut],
  ['GET', '/api/auth/me', me],
  ['GET', '/api/users', listUsers],
  ['POST', '/api/users', createUser],
  ['PATCH', '/api/users/:id', updateUser],
  ['GET', '/api/roles', listRoles],
  ['GET', '/api/sign-ins', signIns],
];
