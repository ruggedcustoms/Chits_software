// Loads what the calculations need for a group, and works out each ticket's account.

import { notFound, todayIst } from './http.js';
import { ticketLedger } from './calc.js';

export async function loadGroup(db, companyId, groupId) {
  const g = await db.prepare('SELECT * FROM chit_groups WHERE company_id = ? AND id = ?').bind(companyId, groupId).first();
  if (!g) throw notFound('Group');
  return g;
}

// Group, active auctions, active tickets, and receipts (not cancelled) with their chosen installments.
export async function loadGroupState(db, companyId, groupId) {
  const g = await loadGroup(db, companyId, groupId);
  const [auctions, enrollments, receipts, insts] = await db.batch([
    db.prepare("SELECT * FROM auctions WHERE group_id = ? AND status = 'Active' ORDER BY auction_no").bind(groupId),
    db.prepare(
      `SELECT e.*, p.name AS person_name, p.member_no, ca.name AS collection_agent_name,
              (SELECT mobile FROM person_addresses a WHERE a.person_id = e.person_id AND a.mobile IS NOT NULL ORDER BY a.kind DESC LIMIT 1) AS mobile
         FROM enrollments e
         LEFT JOIN persons p ON p.id = e.person_id
         LEFT JOIN persons ca ON ca.id = e.collection_agent_id
        WHERE e.group_id = ? AND e.status = 'Active' ORDER BY e.ticket_no`
    ).bind(groupId),
    db.prepare('SELECT * FROM receipts WHERE group_id = ? AND cancelled = 0 ORDER BY receipt_date, receipt_no').bind(groupId),
    db.prepare(
      `SELECT ri.receipt_id, ri.installment_no FROM receipt_installments ri JOIN receipts r ON r.id = ri.receipt_id
        WHERE r.group_id = ? AND r.cancelled = 0`
    ).bind(groupId),
  ]);
  const instsBy = new Map();
  for (const x of insts.results) {
    if (!instsBy.has(x.receipt_id)) instsBy.set(x.receipt_id, []);
    instsBy.get(x.receipt_id).push(x.installment_no);
  }
  const rcpts = receipts.results.map((r) => ({ ...r, insts: instsBy.get(r.id) || [] }));
  return { g, auctions: auctions.results, enrollments: enrollments.results, receipts: rcpts };
}

export function ledgerFor(state, enrollment, asOf = todayIst()) {
  const rs = state.receipts.filter((r) => r.enrollment_id === enrollment.id);
  return ticketLedger(state.g, state.auctions, enrollment, rs, asOf);
}

export const memberCode = (prefix, no) => (prefix || 'M') + String(no || 0).padStart(5, '0');
