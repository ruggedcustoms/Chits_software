// Reports and the audit trail. All amounts are in paise.

import { bad, forbidden, json, todayIst } from '../lib/http.js';
import { can, ownTicketsOnly, requirePerm } from '../lib/auth.js';
import { ledgerFor, loadGroupState } from '../lib/state.js';

const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);

async function groupIds(db, ctx, groupId) {
  if (groupId) return [groupId];
  const { results } = await db.prepare('SELECT id FROM chit_groups WHERE company_id = ? ORDER BY name').bind(ctx.companyId).all();
  return results.map((r) => r.id);
}

// Outstanding and defaulters. A collection agent sees only their own tickets.
async function outstanding({ env, ctx, query }) {
  const own = ownTicketsOnly(ctx);
  if (!own) requirePerm(ctx, 'reports');
  else if (!can(ctx, 'receipts')) throw forbidden();
  const asOf = query.get('as_of') || todayIst();
  const status = query.get('status'); // PS or NPS
  const agentId = own ? ctx.user.person_id : query.get('agent_id');
  const onlyDues = query.get('only_dues') !== '0';
  const rows = [];
  for (const gid of await groupIds(env.DB, ctx, query.get('group_id'))) {
    const s = await loadGroupState(env.DB, ctx.companyId, gid);
    for (const e of s.enrollments) {
      if (e.is_company || (agentId && e.collection_agent_id !== agentId)) continue;
      const L = ledgerFor(s, e, asOf);
      const st = L.prized ? 'PS' : 'NPS';
      if (status && st !== status) continue;
      if (onlyDues && L.arrears <= 0 && L.penalty_due <= 0) continue;
      rows.push({
        group: s.g.name, group_id: s.g.id, ticket_no: e.ticket_no, enrollment_id: e.id, name: e.person_name, mobile: e.mobile, status: st,
        due_so_far: L.total_due, paid: L.total_paid, arrears: L.arrears, advance: L.advance, penalty_due: L.penalty_due,
        total_payable: L.arrears + L.penalty_due, collection_agent: e.collection_agent_name,
      });
    }
  }
  return json({ as_of: asOf, rows, totals: { due_so_far: sum(rows, 'due_so_far'), paid: sum(rows, 'paid'), arrears: sum(rows, 'arrears'), penalty_due: sum(rows, 'penalty_due'), total_payable: sum(rows, 'total_payable') } });
}

// Collection register.
async function collections({ env, ctx, query }) {
  requirePerm(ctx, 'reports');
  const from = query.get('from') || todayIst().slice(0, 8) + '01';
  const to = query.get('to') || todayIst();
  const where = ['r.company_id = ?', 'r.receipt_date BETWEEN ? AND ?'];
  const vals = [ctx.companyId, from, to];
  if (query.get('group_id')) { where.push('r.group_id = ?'); vals.push(query.get('group_id')); }
  if (query.get('mode')) { where.push('r.mode = ?'); vals.push(query.get('mode')); }
  if (query.get('agent_id')) { where.push('r.collection_agent_id = ?'); vals.push(query.get('agent_id')); }
  if (query.get('include_cancelled') !== '1') where.push('r.cancelled = 0');
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.receipt_no, r.receipt_date, g.name AS group_name, e.ticket_no, p.name AS name, r.mode, r.kind,
            r.amount AS subscription, r.penalty, r.enrolment_fee, r.bank_charge + r.other_charge + r.handling_charge AS charges,
            r.amount + r.penalty + r.enrolment_fee + r.bank_charge + r.other_charge + r.handling_charge AS total,
            ag.name AS agent, r.cancelled
       FROM receipts r JOIN chit_groups g ON g.id = r.group_id JOIN enrollments e ON e.id = r.enrollment_id
       LEFT JOIN persons p ON p.id = r.person_id LEFT JOIN persons ag ON ag.id = r.collection_agent_id
      WHERE ${where.join(' AND ')} ORDER BY r.receipt_date, r.receipt_no`
  ).bind(...vals).all();
  const live = results.filter((r) => !r.cancelled);
  const byMode = {};
  for (const r of live) byMode[r.mode] = (byMode[r.mode] || 0) + r.total;
  return json({ from, to, rows: results, totals: { subscription: sum(live, 'subscription'), penalty: sum(live, 'penalty'), enrolment_fee: sum(live, 'enrolment_fee'), charges: sum(live, 'charges'), total: sum(live, 'total') }, by_mode: byMode });
}

// Auction chart of one group.
async function auctionChart({ env, ctx, query }) {
  requirePerm(ctx, 'reports');
  const gid = query.get('group_id');
  if (!gid) throw bad('Choose a group.');
  const { results } = await env.DB.prepare(
    `SELECT a.auction_no, a.auction_date, a.due_date, a.winner_ticket_no, p.name AS winner, a.decided_by, a.bid, a.bid_payable, a.gst, a.net_prize,
            a.commission, a.dividend_pool, a.dividend_per_ticket, a.net_payable_per_ticket
       FROM auctions a LEFT JOIN enrollments e ON e.id = a.winner_enrollment_id LEFT JOIN persons p ON p.id = e.person_id
      WHERE a.company_id = ? AND a.group_id = ? AND a.status = 'Active' ORDER BY a.auction_no`
  ).bind(ctx.companyId, gid).all();
  return json({ rows: results, totals: { bid: sum(results, 'bid'), commission: sum(results, 'commission'), gst: sum(results, 'gst'), net_prize: sum(results, 'net_prize'), dividend_pool: sum(results, 'dividend_pool') } });
}

// Prize payments: what each winner was due, was paid, and is still owed.
async function prizePayments({ env, ctx, query }) {
  requirePerm(ctx, 'reports');
  const where = ["a.company_id = ?", "a.status = 'Active'"];
  const vals = [ctx.companyId];
  if (query.get('group_id')) { where.push('a.group_id = ?'); vals.push(query.get('group_id')); }
  const { results } = await env.DB.prepare(
    `SELECT a.id AS auction_id, g.name AS group_name, a.auction_no, a.winner_ticket_no, p.name AS winner, a.net_prize,
            COALESCE(SUM(CASE WHEN pp.cancelled = 0 THEN pp.amount END), 0) AS paid,
            COALESCE(SUM(CASE WHEN pp.cancelled = 0 THEN pp.adjusted_to_dues END), 0) AS kept_back
       FROM auctions a JOIN chit_groups g ON g.id = a.group_id
       LEFT JOIN enrollments e ON e.id = a.winner_enrollment_id LEFT JOIN persons p ON p.id = e.person_id
       LEFT JOIN prize_payments pp ON pp.auction_id = a.id
      WHERE ${where.join(' AND ')} GROUP BY a.id ORDER BY g.name, a.auction_no`
  ).bind(...vals).all();
  const rows = results.map((r) => ({ ...r, balance: r.net_prize - r.paid - r.kept_back }));
  return json({ rows, totals: { net_prize: sum(rows, 'net_prize'), paid: sum(rows, 'paid'), kept_back: sum(rows, 'kept_back'), balance: sum(rows, 'balance') } });
}

// Trial balance from the vouchers (cancelled vouchers left out) and opening balances.
async function trialBalance({ env, ctx, query }) {
  requirePerm(ctx, 'accounts');
  const asOn = query.get('as_on') || todayIst();
  const { results } = await env.DB.prepare(
    `SELECT la.code, la.name, la.account_group,
            CASE la.opening_side WHEN 'Dr' THEN la.opening_balance ELSE -la.opening_balance END
              + COALESCE((SELECT SUM(vl.debit - vl.credit) FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                           WHERE vl.ledger_account_id = la.id AND v.cancelled = 0 AND v.voucher_date <= ?), 0) AS net
       FROM ledger_accounts la WHERE la.company_id = ? ORDER BY la.code`
  ).bind(asOn, ctx.companyId).all();
  const rows = results.filter((r) => r.net !== 0).map((r) => ({ code: r.code, name: r.name, group: r.account_group, debit: r.net > 0 ? r.net : 0, credit: r.net < 0 ? -r.net : 0 }));
  const debit = sum(rows, 'debit');
  const credit = sum(rows, 'credit');
  return json({ as_on: asOn, rows, totals: { debit, credit }, balanced: debit === credit });
}

// Day book: every voucher of one day with its lines.
async function dayBook({ env, ctx, query }) {
  requirePerm(ctx, 'accounts');
  const day = query.get('date') || todayIst();
  const { results } = await env.DB.prepare(
    `SELECT v.series, v.voucher_no, v.narration, v.cancelled, la.code, la.name AS account, vl.debit, vl.credit
       FROM vouchers v JOIN voucher_lines vl ON vl.voucher_id = v.id JOIN ledger_accounts la ON la.id = vl.ledger_account_id
      WHERE v.company_id = ? AND v.voucher_date = ? ORDER BY v.series, v.voucher_no, vl.line_no`
  ).bind(ctx.companyId, day).all();
  const live = results.filter((r) => !r.cancelled);
  return json({ date: day, rows: results, totals: { debit: sum(live, 'debit'), credit: sum(live, 'credit') } });
}

async function auditLog({ env, ctx, query }) {
  requirePerm(ctx, 'staff');
  const where = ['a.company_id = ?'];
  const vals = [ctx.companyId];
  if (query.get('entity')) { where.push('a.entity = ?'); vals.push(query.get('entity')); }
  if (query.get('entity_id')) { where.push('a.entity_id = ?'); vals.push(query.get('entity_id')); }
  const limit = Math.min(Number(query.get('limit')) || 100, 1000);
  const { results } = await env.DB.prepare(
    `SELECT a.at, u.name AS user, a.action, a.entity, a.entity_id, a.summary FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE ${where.join(' AND ')} ORDER BY a.at DESC LIMIT ?`
  ).bind(...vals, limit).all();
  return json(results);
}

export const reportRoutes = [
  ['GET', '/api/reports/outstanding', outstanding],
  ['GET', '/api/reports/collections', collections],
  ['GET', '/api/reports/auction-chart', auctionChart],
  ['GET', '/api/reports/prize-payments', prizePayments],
  ['GET', '/api/reports/trial-balance', trialBalance],
  ['GET', '/api/reports/day-book', dayBook],
  ['GET', '/api/audit', auditLog],
];
