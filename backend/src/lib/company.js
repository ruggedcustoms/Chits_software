// Creating a company: its roles, chart of accounts, main branch and owner login, in one batch.

import { bad, newId } from './http.js';
import { DEFAULT_ROLES, hashPassword } from './auth.js';
import { auditStatement, chartStatements } from './books.js';

// A short code for links on the company's website: lowercase letters, digits and dashes.
export const CODE_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
export function cleanCode(v) {
  if (v == null || v === '') return null;
  const c = String(v).trim().toLowerCase();
  if (!CODE_RE.test(c)) throw bad('Company code must be 2 to 30 lowercase letters, digits or dashes, for example "mrj".');
  return c;
}

// Ten characters with letters and digits, easy to read out (no 0/O, 1/l/I).
export function tempStaffPassword() {
  const L = 'abcdefghjkmnpqrstuvwxyz', D = '23456789', all = L + L.toUpperCase() + D;
  const r = crypto.getRandomValues(new Uint32Array(10));
  const s = [...r].map((x) => all[x % all.length]);
  s[0] = L[r[0] % L.length].toUpperCase();
  s[9] = D[r[9] % D.length];
  return s.join('');
}

// c: { name, code, owner_name, username, password, must_change, phone, email, city, state, plan, valid_till, grace_days, brand }
// audit: who the audit row names (null for the provider; the provider keeps its own log).
export async function companyStatements(db, c) {
  const companyId = newId();
  const branchId = newId();
  const userId = newId();
  const roles = DEFAULT_ROLES.map((r) => ({ ...r, id: newId() }));
  const ctx = { companyId, user: { id: userId } };
  const stmts = [
    db.prepare(`INSERT INTO companies (id, name, owner_name, phone, email, city, state, code, plan, valid_till, grace_days, brand_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(companyId, c.name, c.owner_name, c.phone || null, c.email || null, c.city || null, c.state || null, c.code || null,
        c.plan || 'Standard', c.valid_till || null, c.grace_days ?? 15, JSON.stringify(c.brand || {})),
    db.prepare('INSERT INTO branches (id, company_id, name) VALUES (?, ?, ?)').bind(branchId, companyId, 'Main branch'),
    ...roles.map((r) => db.prepare('INSERT INTO roles (id, company_id, name, is_system, perms_json) VALUES (?, ?, ?, ?, ?)')
      .bind(r.id, companyId, r.name, r.is_system || 0, JSON.stringify(r.perms))),
    ...chartStatements(db, companyId),
    db.prepare('INSERT INTO users (id, company_id, role_id, name, username, password_hash, must_change) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, companyId, roles[0].id, c.owner_name, c.username, await hashPassword(c.password), c.must_change ? 1 : 0),
    auditStatement(db, ctx, 'create', 'companies', companyId, `Company ${c.name} set up with owner login ${c.username}`),
  ];
  return { stmts, companyId, branchId, userId };
}
