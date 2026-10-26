// Member app: logins the office issues, and what a signed-in member may see (only their own tickets).
// Amounts for the member app are in rupees, the shape the app's screens already use.

import { bad, forbidden, json, notFound, nowIso, readBody, str, todayIst } from '../lib/http.js';
import { checkMemberPassword, hashPassword, memberLogin, memberLogout, requirePerm, sha256Hex, tempPassword, verifyPassword } from '../lib/auth.js';
import { auditStatement } from '../lib/books.js';
import { monthsLate } from '../lib/calc.js';
import { ledgerFor, loadGroupState, memberCode } from '../lib/state.js';
import { companyIdFrom } from './auth.js';

const parse = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};
const rup = (p) => (p || 0) / 100;
// The company's colours and logo for the app's look.
const brandOf = (s) => { const b = parse(s); return { color: b.color || null, accent: b.accent || null, logo: b.logo || null }; };
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthOf = (d) => (d ? MON[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : '');

async function prefixOf(db, companyId) {
  const co = await db.prepare('SELECT member_prefix, settings_json FROM companies WHERE id = ?').bind(companyId).first();
  const set = parse(co && co.settings_json);
  return set.mPrefix != null ? set.mPrefix : co ? co.member_prefix : 'M';
}

// ---- office: issuing logins ----

async function listLogins({ env, ctx }) {
  requirePerm(ctx, 'members');
  const { results } = await env.DB.prepare(
    `SELECT l.person_id, p.member_no, l.must_change, l.active, l.issued_at, u.name AS issued_by, l.last_sign_in, l.locked_until
       FROM member_logins l JOIN persons p ON p.id = l.person_id LEFT JOIN users u ON u.id = l.issued_by
      WHERE l.company_id = ?`
  ).bind(ctx.companyId).all();
  const now = nowIso();
  return json(results.map((r) => ({ ...r, locked: !!(r.locked_until && r.locked_until > now), locked_until: undefined })));
}

// Gives a member a new temporary password (a new login, or a reset). The password is returned only here.
async function issueStatements(db, ctx, person, prefix, existed) {
  const password = tempPassword();
  const hash = await hashPassword(password);
  const username = memberCode(prefix, person.member_no);
  const stmts = [
    db.prepare(
      `INSERT INTO member_logins (person_id, company_id, password_hash, must_change, active, failed_attempts, locked_until, issued_at, issued_by)
       VALUES (?, ?, ?, 1, 1, 0, NULL, ?, ?)
       ON CONFLICT (person_id) DO UPDATE SET password_hash = excluded.password_hash, must_change = 1, active = 1, failed_attempts = 0,
         locked_until = NULL, issued_at = excluded.issued_at, issued_by = excluded.issued_by`
    ).bind(person.id, ctx.companyId, hash, nowIso(), ctx.user.id),
    db.prepare('DELETE FROM member_sessions WHERE person_id = ?').bind(person.id),
    auditStatement(db, ctx, existed ? 'update' : 'create', 'member_logins', person.id, `Member app ${existed ? 'password reset' : 'login issued'}: ${username} (${person.name})`),
  ];
  return { stmts, issued: { person_id: person.id, name: person.name, username, password } };
}

async function issueLogin({ request, env, ctx }) {
  requirePerm(ctx, 'members', 'edit');
  const b = await readBody(request);
  const db = env.DB;
  const personId = str(b, 'person_id', { required: true, label: 'member' });
  const person = await db.prepare('SELECT id, name, member_no FROM persons WHERE company_id = ? AND id = ?').bind(ctx.companyId, personId).first();
  if (!person) throw notFound('Member');
  const existed = !!(await db.prepare('SELECT 1 FROM member_logins WHERE person_id = ?').bind(person.id).first());
  const { stmts, issued } = await issueStatements(db, ctx, person, await prefixOf(db, ctx.companyId), existed);
  await db.batch(stmts);
  return json(issued, existed ? 200 : 201);
}

// Logins for every enrolled member who has none, a batch at a time (each password hash takes time).
const BULK = 25;
async function issueBulk({ env, ctx }) {
  requirePerm(ctx, 'members', 'edit');
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT DISTINCT p.id, p.name, p.member_no FROM persons p JOIN enrollments e ON e.person_id = p.id AND e.status = 'Active'
      WHERE p.company_id = ? AND NOT EXISTS (SELECT 1 FROM member_logins l WHERE l.person_id = p.id) ORDER BY p.member_no`
  ).bind(ctx.companyId).all();
  const prefix = await prefixOf(db, ctx.companyId);
  const stmts = [];
  const issued = [];
  for (const person of results.slice(0, BULK)) {
    const x = await issueStatements(db, ctx, person, prefix, false);
    stmts.push(...x.stmts);
    issued.push(x.issued);
  }
  if (stmts.length) await db.batch(stmts);
  return json({ issued, remaining: Math.max(0, results.length - BULK) });
}

async function updateLogin({ request, env, ctx, params }) {
  requirePerm(ctx, 'members', 'edit');
  const db = env.DB;
  const row = await db.prepare('SELECT l.*, p.name, p.member_no FROM member_logins l JOIN persons p ON p.id = l.person_id WHERE l.company_id = ? AND l.person_id = ?')
    .bind(ctx.companyId, params.id).first();
  if (!row) throw notFound('Member app login');
  const b = await readBody(request);
  if (b.active == null && !b.unlock) throw bad('Nothing to change.');
  const sets = [];
  const changes = [];
  if (b.active != null) { sets.push('active = ' + (b.active ? 1 : 0)); changes.push(b.active ? 'switched on' : 'switched off'); }
  if (b.unlock) { sets.push('failed_attempts = 0', 'locked_until = NULL'); changes.push('unlocked'); }
  const username = memberCode(await prefixOf(db, ctx.companyId), row.member_no);
  const stmts = [
    db.prepare(`UPDATE member_logins SET ${sets.join(', ')} WHERE person_id = ?`).bind(row.person_id),
    auditStatement(db, ctx, 'update', 'member_logins', row.person_id, `Member app login ${username} (${row.name}): ${changes.join(', ')}`),
  ];
  if (b.active === false || b.active === 0) stmts.push(db.prepare('DELETE FROM member_sessions WHERE person_id = ?').bind(row.person_id));
  await db.batch(stmts);
  return json({ ok: true, changes });
}

async function removeLogin({ env, ctx, params }) {
  requirePerm(ctx, 'members', 'edit');
  const db = env.DB;
  const row = await db.prepare('SELECT l.person_id, p.name, p.member_no FROM member_logins l JOIN persons p ON p.id = l.person_id WHERE l.company_id = ? AND l.person_id = ?')
    .bind(ctx.companyId, params.id).first();
  if (!row) throw notFound('Member app login');
  const username = memberCode(await prefixOf(db, ctx.companyId), row.member_no);
  await db.batch([
    db.prepare('DELETE FROM member_sessions WHERE person_id = ?').bind(row.person_id),
    db.prepare('DELETE FROM member_logins WHERE person_id = ?').bind(row.person_id),
    auditStatement(db, ctx, 'delete', 'member_logins', row.person_id, `Member app login removed: ${username} (${row.name})`),
  ]);
  return json({ ok: true });
}

// ---- member: signing in ----

async function signIn({ request, env }) {
  const b = await readBody(request);
  const username = str(b, 'username', { required: true, label: 'member number' });
  if (typeof b.password !== 'string' || !b.password) throw bad('Enter the password.');
  const companyId = await companyIdFrom(env.DB, b);
  return json(await memberLogin(env.DB, companyId, username, b.password, request.headers.get('cf-connecting-ip')));
}

async function signOut({ env, ctx }) {
  await memberLogout(env.DB, ctx.token);
  return json({ ok: true });
}

async function changePassword({ request, env, ctx }) {
  const b = await readBody(request);
  const db = env.DB;
  const row = await db.prepare('SELECT password_hash FROM member_logins WHERE person_id = ?').bind(ctx.member.id).first();
  if (typeof b.current_password !== 'string' || !(await verifyPassword(b.current_password, row.password_hash))) throw bad('Your current password is wrong.');
  const username = memberCode(await prefixOf(db, ctx.companyId), ctx.member.member_no);
  const err = checkMemberPassword(b.new_password, username);
  if (err) throw bad(err);
  if (b.new_password === b.current_password) throw bad('Choose a new password, different from the current one.');
  await db.batch([
    db.prepare('UPDATE member_logins SET password_hash = ?, must_change = 0 WHERE person_id = ?').bind(await hashPassword(b.new_password), ctx.member.id),
    // Other phones signed in with the old password are signed out.
    db.prepare('DELETE FROM member_sessions WHERE person_id = ? AND token_hash != ?').bind(ctx.member.id, await sha256Hex(ctx.token)),
    db.prepare('INSERT INTO audit_log (id, company_id, user_id, action, entity, entity_id, summary) VALUES (?, ?, NULL, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), ctx.companyId, 'update', 'member_logins', ctx.member.id, `Member app password changed by the member (${username})`),
  ]);
  return json({ ok: true });
}

// ---- member: their own chits ----

// The next auction: the date set at the last auction, or the group's auction day in the coming month.
function nextAuction(g, auctions, today) {
  if (auctions.length >= g.installments || g.status === 'Closed') return '';
  const last = auctions[auctions.length - 1];
  if (last && last.next_auction_date && last.next_auction_date >= today) return last.next_auction_date;
  const day = g.auction_day;
  if (!(day >= 1 && day <= 31) || (g.auction_type && g.auction_type !== 'Monthly')) return '';
  const [y, m, d] = today.split('-').map(Number);
  const at = (yy, mm) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
  };
  return d <= day ? at(y, m) : m === 12 ? at(y + 1, 1) : at(y, m + 1);
}

async function home({ env, ctx }) {
  if (ctx.mustChange) throw forbidden('Please set your own password first.');
  const db = env.DB;
  const today = todayIst();
  const pid = ctx.member.id;
  const [company, person, addresses, enrolls, branches] = await db.batch([
    db.prepare('SELECT name, phone, member_prefix, settings_json, brand_json FROM companies WHERE id = ?').bind(ctx.companyId),
    db.prepare('SELECT id, name, member_no, entry_date FROM persons WHERE company_id = ? AND id = ?').bind(ctx.companyId, pid),
    db.prepare('SELECT * FROM person_addresses WHERE person_id = ?').bind(pid),
    db.prepare("SELECT id, group_id FROM enrollments WHERE company_id = ? AND person_id = ? AND status = 'Active'").bind(ctx.companyId, pid),
    db.prepare('SELECT id, name FROM branches WHERE company_id = ?').bind(ctx.companyId),
  ]);
  const co = company.results[0];
  const set = parse(co.settings_json);
  const p = person.results[0];
  const addr = addresses.results.find((a) => a.kind === 'residential') || addresses.results[0] || {};
  const branchName = new Map(branches.results.map((b) => [b.id, b.name]));

  const chits = [];
  const receipts = [];
  for (const gid of [...new Set(enrolls.results.map((e) => e.group_id))]) {
    const s = await loadGroupState(db, ctx.companyId, gid);
    const g = s.g;
    const gx = parse(g.extra_json);
    const auctions = s.auctions.slice().sort((a, b) => a.auction_no - b.auction_no);
    for (const e of s.enrollments.filter((x) => x.person_id === pid)) {
      const L = ledgerFor(s, e, today);
      const recs = s.receipts.filter((r) => r.enrollment_id === e.id).sort((a, b) => a.receipt_date.localeCompare(b.receipt_date) || a.receipt_no - b.receipt_no);
      // When each installment was cleared: the receipt that brought the payments up to it.
      let cum = 0;
      const steps = recs.map((r) => ({ at: (cum += r.amount), date: r.receipt_date }));
      let need = 0;
      const rows = L.rows.map((r) => {
        need += r.due;
        const paid = r.paid >= r.due;
        const late = !paid && r.due_date && r.due_date < today ? monthsLate(r.due_date, today) : 0;
        return {
          no: r.no, month: monthOf(r.due_date), due: r.due_date, inst: rup(L.installment), div: rup(r.dividend), payable: rup(r.due), paid,
          paidOn: paid ? (steps.find((x) => x.at >= need) || steps[steps.length - 1] || {}).date || '' : '',
          left: rup(r.due - r.paid), late, pen: rup(r.late_fee || 0), ps: r.ps,
        };
      });
      const won = auctions.find((a) => a.winner_enrollment_id === e.id);
      let prize = null;
      if (won) {
        const { results: pays } = await db.prepare('SELECT payment_date, amount, adjusted_to_dues, mode, reference FROM prize_payments WHERE auction_id = ? AND cancelled = 0 ORDER BY payment_date')
          .bind(won.id).all();
        prize = {
          company: !!won.company_won, bid: rup(won.bid), bidPayable: rup(won.bid_payable), comm: rup(won.commission), gst: rup(won.gst), netPrize: rup(won.net_prize),
          paid: rup(pays.reduce((t, x) => t + x.amount, 0)), adjusted: rup(pays.reduce((t, x) => t + (x.adjusted_to_dues || 0), 0)),
          payments: pays.map((x) => ({ date: x.payment_date, amount: rup(x.amount), adjusted: rup(x.adjusted_to_dues), mode: x.mode, ref: x.reference || '' })),
        };
        prize.balance = prize.company ? 0 : Math.max(0, prize.netPrize - prize.paid - prize.adjusted);
      }
      chits.push({
        id: e.id, group: g.name, ticket: e.ticket_no, amount: rup(g.chit_amount), inst: rup(L.installment), n: g.installments, have: rows.length,
        won: L.won_auction_no || 0, branch: branchName.get(g.branch_id) || '', bylaw: g.bylaw_no || '', next: nextAuction(g, auctions, today),
        time: g.auction_time_from || '', venue: gx.venue || '', rateNps: (g.late_fee_nps_bp || 0) / 100, ratePs: (g.late_fee_ps_bp || 0) / 100,
        perYear: g.late_fee_basis === 'year', advance: rup(L.advance), penaltyDue: rup(L.penalty_due), rows,
        auc: auctions.map((a) => ({ no: a.auction_no, date: a.auction_date, bid: rup(a.bid), div: rup(a.dividend_per_ticket), ticket: a.winner_ticket_no })),
        prize,
      });
      for (const r of recs) {
        receipts.push({
          id: r.id, no: r.receipt_no, date: r.receipt_date, chit: e.id, group: g.name, ticket: e.ticket_no, mode: r.mode, insts: r.insts,
          amount: rup(r.amount), penalty: rup(r.penalty), other: rup(r.enrolment_fee + r.bank_charge + r.other_charge + r.handling_charge),
          total: rup(r.amount + r.penalty + r.enrolment_fee + r.bank_charge + r.other_charge + r.handling_charge),
        });
      }
    }
  }
  chits.sort((a, b) => a.group.localeCompare(b.group) || a.ticket - b.ticket);
  receipts.sort((a, b) => b.date.localeCompare(a.date) || b.no - a.no);
  const prefix = set.mPrefix != null ? set.mPrefix : co.member_prefix;
  return json({
    as_of: today,
    company: { name: set.company || co.name, phone: set.coPhone || set.coMobile || co.phone || '', upi: set.upi || '', upiName: set.upiName || '', brand: brandOf(co.brand_json) },
    member: {
      name: p.name, mno: memberCode(prefix, p.member_no), mobile: addr.mobile || '', since: p.entry_date || '',
      address: [addr.door, addr.street, addr.area, addr.city, addr.pin].filter(Boolean).join(', '),
    },
    chits,
    receipts,
  });
}

export const memberRoutes = [
  ['GET', '/api/member-logins', listLogins],
  ['POST', '/api/member-logins', issueLogin],
  ['POST', '/api/member-logins/bulk', issueBulk],
  ['PATCH', '/api/member-logins/:id', updateLogin],
  ['DELETE', '/api/member-logins/:id', removeLogin],
  ['POST', '/api/member/login', signIn, { public: true }],
  ['POST', '/api/member/logout', signOut, { member: true }],
  ['POST', '/api/member/password', changePassword, { member: true }],
  ['GET', '/api/member/home', home, { member: true }],
];
