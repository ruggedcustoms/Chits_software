// Everything the office screens need in one request, and the company's shared settings.

import { bad, forbidden, json, readBody } from '../lib/http.js';
import { can, ownTicketsOnly, requirePerm } from '../lib/auth.js';
import { auditStatement } from '../lib/books.js';

const parse = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};

async function sync({ env, ctx }) {
  if (ownTicketsOnly(ctx)) throw forbidden('Collection agents use the agent app.');
  requirePerm(ctx, 'dash');
  const db = env.DB;
  const c = ctx.companyId;
  const [company, groups, persons, addresses, enrollments, auctions, receipts, insts, payments, users] = await db.batch([
    db.prepare('SELECT id, name, member_prefix, settings_json FROM companies WHERE id = ?').bind(c),
    db.prepare('SELECT * FROM chit_groups WHERE company_id = ? ORDER BY name').bind(c),
    db.prepare('SELECT * FROM persons WHERE company_id = ? ORDER BY member_no').bind(c),
    db.prepare('SELECT a.* FROM person_addresses a JOIN persons p ON p.id = a.person_id WHERE p.company_id = ?').bind(c),
    db.prepare("SELECT * FROM enrollments WHERE company_id = ? AND status = 'Active' ORDER BY group_id, ticket_no").bind(c),
    db.prepare("SELECT * FROM auctions WHERE company_id = ? AND status = 'Active' ORDER BY group_id, auction_no").bind(c),
    db.prepare('SELECT r.*, e.ticket_no FROM receipts r JOIN enrollments e ON e.id = r.enrollment_id WHERE r.company_id = ? ORDER BY r.receipt_no').bind(c),
    db.prepare('SELECT ri.receipt_id, ri.installment_no FROM receipt_installments ri JOIN receipts r ON r.id = ri.receipt_id WHERE r.company_id = ?').bind(c),
    db.prepare('SELECT * FROM prize_payments WHERE company_id = ? ORDER BY voucher_no').bind(c),
    db.prepare('SELECT id, name FROM users WHERE company_id = ?').bind(c),
  ]);
  const co = company.results[0];
  const addrBy = new Map();
  for (const a of addresses.results) (addrBy.get(a.person_id) || addrBy.set(a.person_id, []).get(a.person_id)).push(a);
  const instBy = new Map();
  for (const x of insts.results) (instBy.get(x.receipt_id) || instBy.set(x.receipt_id, []).get(x.receipt_id)).push(x.installment_no);
  const withExtra = (rows) => rows.map((r) => ({ ...r, extra: parse(r.extra_json), extra_json: undefined }));
  return json({
    me: { user: ctx.user, role: ctx.role, perms: ctx.perms },
    company: { id: co.id, name: co.name, member_prefix: co.member_prefix, settings: parse(co.settings_json) },
    users: users.results,
    groups: withExtra(groups.results),
    persons: withExtra(persons.results).map((p) => ({ ...p, roles: parse(p.roles_json), roles_json: undefined, addresses: addrBy.get(p.id) || [] })),
    enrollments: withExtra(enrollments.results),
    auctions: withExtra(auctions.results),
    receipts: withExtra(receipts.results).map((r) => ({ ...r, insts: (instBy.get(r.id) || []).sort((a, b) => a - b) })),
    prize_payments: withExtra(payments.results),
  });
}

// Day-to-day lists any staff member may keep (calls to make, enquiries, notices, SMS log).
// Also the voucher series a clerk sets while paying a prize.
const OPS_KEYS = ['calls', 'enq', 'notices', 'smsLog', 'hist', 'bpSeries', 'bvSeries'];

// Merges the given keys into the company's settings, so two people changing different
// settings do not overwrite each other.
async function updateSettings({ request, env, ctx }) {
  const b = await readBody(request);
  const values = b.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw bad('Send { "values": { ... } }.');
  const keys = Object.keys(values);
  if (!keys.length) throw bad('Nothing to save.');
  const opsOnly = keys.every((k) => OPS_KEYS.includes(k));
  if (opsOnly) {
    if (ownTicketsOnly(ctx) || !['receipts', 'members', 'reports'].some((a) => can(ctx, a, 'edit') || can(ctx, a))) throw forbidden();
  } else {
    requirePerm(ctx, 'settings', 'edit');
  }
  const db = env.DB;
  const row = await db.prepare('SELECT settings_json FROM companies WHERE id = ?').bind(ctx.companyId).first();
  const merged = { ...parse(row.settings_json), ...values };
  const text = JSON.stringify(merged);
  if (text.length > 1_500_000) throw bad('The settings are too large. Remove old SMS logs or notices.');
  const stmts = [db.prepare('UPDATE companies SET settings_json = ? WHERE id = ?').bind(text, ctx.companyId)];
  if (!opsOnly) stmts.push(auditStatement(db, ctx, 'update', 'companies', ctx.companyId, `Settings changed: ${keys.join(', ')}`));
  await db.batch(stmts);
  return json({ ok: true, saved: keys });
}

export const syncRoutes = [
  ['GET', '/api/sync', sync],
  ['PATCH', '/api/settings', updateSettings],
];
