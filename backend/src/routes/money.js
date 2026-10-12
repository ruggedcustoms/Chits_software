// Auctions, receipts and prize payments. Each one saves its record, its accounting voucher
// and its audit row in one batch, so the books always match the records.

import { bad, clientId, conflict, date, extra, forbidden, int, json, newId, notFound, oneOf, paise, readBody, str, todayIst } from '../lib/http.js';
import { ownTicketsOnly, requirePerm } from '../lib/auth.js';
import { AC, auditStatement, cancelVoucherStatement, voucherStatements } from '../lib/books.js';
import { auctionFigures, decideBid, rs } from '../lib/calc.js';
import { ledgerFor, loadGroupState } from '../lib/state.js';

const DECIDED_BY = ['bidding', 'bid offer', 'proxy', 'lottery', 'company'];
const ALLOWED = {
  both: ['bidding', 'bid offer', 'proxy', 'lottery', 'company'],
  bidding: ['bidding', 'bid offer', 'proxy', 'company'],
  lottery: ['lottery', 'company'],
  company: ['company'],
};
const PAY_MODES = ['Cash', 'Cheque', 'D.D.', 'RTGS/NEFT', 'NEFT', 'RTGS', 'UPI', 'Card'];
const cashOrBank = (mode) => (mode === 'Cash' ? AC.cash : AC.bank);

// ---- auctions ----

async function auctionInput(db, ctx, b) {
  const s = await loadGroupState(db, ctx.companyId, str(b, 'group_id', { required: true, label: 'group' }));
  const { g } = s;
  const auctionNo = s.auctions.length + 1;
  if (auctionNo > g.installments) throw conflict(`All ${g.installments} auctions of ${g.name} are done.`);
  const decidedBy = oneOf(b, 'decided_by', DECIDED_BY, { fallback: 'bidding' });
  if (!ALLOWED[g.auction_method].includes(decidedBy)) throw bad(`${g.name} does not allow an auction decided by ${decidedBy}.`);
  const decided = decideBid(g, auctionNo, decidedBy, b.bid);
  if (decided.error) throw bad(decided.error);
  // GST % can be changed for one auction, as on the office screen.
  const gstBp = int(b, 'gst_bp', { max: 10000, label: 'GST %' }) ?? g.gst_bp;
  return { s, g, auctionNo, decidedBy, figures: auctionFigures(g, decided.bid, gstBp), noAuction: !!decided.noAuction };
}

async function previewAuction({ request, env, ctx }) {
  requirePerm(ctx, 'auctions');
  const { g, auctionNo, decidedBy, figures, noAuction } = await auctionInput(env.DB, ctx, await readBody(request));
  return json({ group: g.name, auction_no: auctionNo, decided_by: decidedBy, no_auction_month: noAuction, ...figures });
}

async function createAuction({ request, env, ctx }) {
  requirePerm(ctx, 'auctions', 'edit');
  const db = env.DB;
  const b = await readBody(request);
  const { s, g, auctionNo, decidedBy, figures } = await auctionInput(db, ctx, b);
  const auctionDate = date(b, 'auction_date', { required: true, label: 'auction date' });
  if (auctionDate < g.start_date) throw bad('The auction date is before the group starts.');
  const last = s.auctions[s.auctions.length - 1];
  if (last && auctionDate < last.auction_date) throw bad(`The auction date is before auction ${last.auction_no} (${last.auction_date}).`);

  const ticket = int(b, 'winner_ticket_no', { required: true, min: 1, max: g.installments, label: 'winning ticket' });
  const e = s.enrollments.find((x) => x.ticket_no === ticket);
  if (!e) throw bad(`Ticket ${ticket} is vacant.`);
  // A company ticket can take the chit only in the first months with no auction.
  if (e.is_company && auctionNo > (g.no_auction_installments || 0)) throw bad('A company ticket cannot win.');
  const prev = s.auctions.find((a) => a.winner_enrollment_id === e.id);
  if (prev) throw conflict(`Ticket ${ticket} already won auction ${prev.auction_no}.`);

  const id = clientId(b);
  const narration = `Auction ${auctionNo} of ${g.name}: ticket ${ticket}, bid ${rs(figures.bid)}`;
  await db.batch([
    db.prepare(
      `INSERT INTO auctions (id, company_id, group_id, auction_no, auction_date, due_date, next_auction_date, winner_enrollment_id, winner_ticket_no,
         decided_by, company_won, bid, commission, gst_bp, gst, bid_payable, net_prize, dividend_pool, dividend_per_ticket, net_payable_per_ticket, minutes_filed_on, extra_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ctx.companyId, g.id, auctionNo, auctionDate, date(b, 'due_date') || auctionDate, date(b, 'next_auction_date'), e.id, ticket,
      decidedBy, e.is_company, figures.bid, figures.commission, figures.gst_bp, figures.gst, figures.bid_payable, figures.net_prize, figures.dividend_pool,
      figures.dividend_per_ticket, figures.net_payable_per_ticket, date(b, 'minutes_filed_on'), extra(b), ctx.user.id
    ),
    // The prize, commission and GST come out of the subscriptions held for the group.
    ...voucherStatements(db, ctx, {
      series: 'AUC', date: auctionDate, sourceTable: 'auctions', sourceId: id, narration,
      lines: [
        { code: AC.held, dr: figures.bid_payable + figures.commission, group_id: g.id },
        { code: AC.bidPayable, cr: figures.net_prize, group_id: g.id, enrollment_id: e.id },
        { code: AC.commission, cr: figures.commission, group_id: g.id },
        { code: AC.gstPayable, cr: figures.gst, group_id: g.id },
      ],
    }),
    auditStatement(db, ctx, 'create', 'auctions', id, narration, null, { auction_no: auctionNo, ticket, decided_by: decidedBy, ...figures }),
  ]);
  return json({ id, auction_no: auctionNo, winner_ticket_no: ticket, ...figures }, 201);
}

// ---- receipts ----

async function findTicket(db, ctx, b) {
  const enrollmentId = str(b, 'enrollment_id');
  const e = enrollmentId
    ? await db.prepare("SELECT * FROM enrollments WHERE company_id = ? AND id = ? AND status = 'Active'").bind(ctx.companyId, enrollmentId).first()
    : await db.prepare("SELECT * FROM enrollments WHERE company_id = ? AND group_id = ? AND ticket_no = ? AND status = 'Active'")
      .bind(ctx.companyId, str(b, 'group_id', { required: true, label: 'group' }), int(b, 'ticket_no', { required: true, min: 1, label: 'ticket' })).first();
  if (!e) throw notFound('Ticket');
  return e;
}

async function createReceipt({ request, env, ctx }) {
  requirePerm(ctx, 'receipts', 'edit');
  const db = env.DB;
  const b = await readBody(request);
  const e = await findTicket(db, ctx, b);
  let agentId = str(b, 'collection_agent_id') || e.collection_agent_id;
  if (ownTicketsOnly(ctx)) {
    if (e.collection_agent_id !== ctx.user.person_id) throw forbidden('This ticket is not assigned to you.');
    agentId = ctx.user.person_id;
  }
  const s = await loadGroupState(db, ctx.companyId, e.group_id);
  const { g } = s;

  const receiptDate = date(b, 'receipt_date') || todayIst();
  if (receiptDate > todayIst()) throw bad('The receipt date cannot be in the future.');
  const mode = oneOf(b, 'mode', PAY_MODES, { required: true, label: 'payment mode' });
  const f = {
    amount: paise(b, 'amount') ?? 0,
    penalty: paise(b, 'penalty') ?? 0,
    enrolment_fee: paise(b, 'enrolment_fee') ?? 0,
    bank_charge: paise(b, 'bank_charge') ?? 0,
    other_charge: paise(b, 'other_charge') ?? 0,
  };
  const total = f.amount + f.penalty + f.enrolment_fee + f.bank_charge + f.other_charge;
  if (total <= 0) throw bad('Enter the amount received.');
  const cheque = mode === 'Cheque' || mode === 'D.D.';
  const chequeNo = str(b, 'cheque_no', { required: cheque, max: 20, label: 'cheque or DD number' });
  const insts = b.insts == null ? [] : b.insts;
  if (!Array.isArray(insts) || insts.some((k) => !Number.isInteger(k) || k < 1 || k > g.installments)) throw bad(`Installments must be numbers from 1 to ${g.installments}.`);

  // How much of each chosen installment this receipt pays, given what was paid before.
  const L = ledgerFor(s, e, receiptDate);
  let left = f.amount;
  const split = [...new Set(insts)].sort((a, c) => a - c).map((k) => {
    const row = L.rows.find((r) => r.no === k);
    const take = row ? Math.max(0, Math.min(left, row.due - row.paid)) : 0;
    left -= take;
    return [k, take];
  });

  const id = clientId(b);
  const narration = `Ticket ${e.ticket_no} of ${g.name}, ${mode}`;
  await db.batch([
    db.prepare(
      `INSERT INTO receipts (id, company_id, receipt_no, receipt_date, kind, mode, group_id, enrollment_id, person_id, collection_agent_id, tr_book_no, tr_date,
         amount, penalty, enrolment_fee, bank_charge, other_charge, cheque_no, cheque_bank, cheque_date, cheque_place, cheque_status, reason, old_no, extra_json, created_by)
       VALUES (?, ?, (SELECT COALESCE(MAX(receipt_no), 0) + 1 FROM receipts WHERE company_id = ?), ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, ctx.companyId, ctx.companyId, receiptDate, mode, g.id, e.id, e.person_id, agentId, str(b, 'tr_book_no'), date(b, 'tr_date'),
      f.amount, f.penalty, f.enrolment_fee, f.bank_charge, f.other_charge,
      chequeNo, str(b, 'cheque_bank'), date(b, 'cheque_date'), str(b, 'cheque_place'), cheque ? 'Pending' : null, str(b, 'reason', { max: 400 }), str(b, 'old_no'), extra(b), ctx.user.id
    ),
    ...split.map(([k, amt]) => db.prepare('INSERT INTO receipt_installments (receipt_id, installment_no, amount) VALUES (?, ?, ?)').bind(id, k, amt)),
    ...voucherStatements(db, ctx, {
      series: 'RCT', date: receiptDate, sourceTable: 'receipts', sourceId: id, narration,
      lines: [
        { code: cashOrBank(mode), dr: total },
        { code: AC.held, cr: f.amount, group_id: g.id, enrollment_id: e.id },
        { code: AC.penalty, cr: f.penalty, group_id: g.id, enrollment_id: e.id },
        { code: AC.enrolFee, cr: f.enrolment_fee, group_id: g.id, enrollment_id: e.id },
        { code: AC.other, cr: f.bank_charge + f.other_charge, group_id: g.id, enrollment_id: e.id },
      ],
    }),
    auditStatement(db, ctx, 'create', 'receipts', id, `Receipt ${rs(total)}: ${narration}`, null, { ...f, mode, receipt_date: receiptDate, insts }),
  ]);
  const saved = await db.prepare('SELECT receipt_no FROM receipts WHERE id = ?').bind(id).first();
  const after = ledgerFor(await loadGroupState(db, ctx.companyId, g.id), e, receiptDate);
  return json({ id, receipt_no: saved.receipt_no, total, balance_after: after.balance, arrears_after: after.arrears, advance_after: after.advance }, 201);
}

async function getReceipt({ env, ctx, params }) {
  requirePerm(ctx, 'receipts');
  const r = await env.DB.prepare(
    `SELECT r.*, g.name AS group_name, e.ticket_no, p.name AS person_name, ag.name AS agent_name
       FROM receipts r JOIN chit_groups g ON g.id = r.group_id JOIN enrollments e ON e.id = r.enrollment_id
       LEFT JOIN persons p ON p.id = r.person_id LEFT JOIN persons ag ON ag.id = r.collection_agent_id
      WHERE r.company_id = ? AND r.id = ?`
  ).bind(ctx.companyId, params.id).first();
  if (!r) throw notFound('Receipt');
  if (ownTicketsOnly(ctx) && r.collection_agent_id !== ctx.user.person_id) throw forbidden();
  const { results } = await env.DB.prepare('SELECT installment_no, amount FROM receipt_installments WHERE receipt_id = ? ORDER BY installment_no').bind(r.id).all();
  return json({ ...r, total: r.amount + r.penalty + r.enrolment_fee + r.bank_charge + r.other_charge + r.handling_charge, installments: results });
}

async function cancelReceipt({ request, env, ctx, params }) {
  requirePerm(ctx, 'cancelRc', 'edit');
  const db = env.DB;
  const r = await db.prepare('SELECT * FROM receipts WHERE company_id = ? AND id = ?').bind(ctx.companyId, params.id).first();
  if (!r) throw notFound('Receipt');
  if (r.cancelled) throw conflict(`Receipt ${r.receipt_no} is already cancelled.`);
  if (r.kind === 'adjustment') throw conflict('This receipt was made by a prize payment. Cancel that payment instead.');
  const reason = str(await readBody(request), 'reason', { required: true, max: 400, label: 'the reason for cancelling' });
  await db.batch([
    db.prepare('UPDATE receipts SET cancelled = 1, cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?').bind(new Date().toISOString(), ctx.user.id, reason, r.id),
    cancelVoucherStatement(db, ctx, 'receipts', r.id),
    auditStatement(db, ctx, 'cancel', 'receipts', r.id, `Receipt ${r.receipt_no} cancelled: ${reason}`, { cancelled: 0 }, { cancelled: 1, reason }),
  ]);
  return json({ ok: true, receipt_no: r.receipt_no });
}

// ---- prize payments ----

async function createPrizePayment({ request, env, ctx }) {
  requirePerm(ctx, 'payable', 'edit');
  const db = env.DB;
  const b = await readBody(request);
  const a = await db.prepare("SELECT * FROM auctions WHERE company_id = ? AND id = ? AND status = 'Active'").bind(ctx.companyId, str(b, 'auction_id', { required: true, label: 'auction' })).first();
  if (!a) throw notFound('Auction');
  const s = await loadGroupState(db, ctx.companyId, a.group_id);
  const e = s.enrollments.find((x) => x.id === a.winner_enrollment_id);
  if (!e) throw conflict('The winning ticket is no longer active.');

  const payDate = date(b, 'payment_date') || todayIst();
  if (payDate < a.auction_date) throw bad('The payment date is before the auction.');
  const mode = oneOf(b, 'mode', PAY_MODES, { required: true, label: 'payment mode' });
  const amount = paise(b, 'amount') ?? 0;
  const adjusted = paise(b, 'adjusted_to_dues') ?? 0;
  if (amount + adjusted <= 0) throw bad('Enter the amount paid.');
  const done = await db.prepare('SELECT COALESCE(SUM(amount + adjusted_to_dues + adjusted_advance), 0) AS t FROM prize_payments WHERE auction_id = ? AND cancelled = 0').bind(a.id).first();
  const remaining = a.net_prize - done.t;
  if (amount + adjusted > remaining) throw bad(`Only ${rs(remaining)} of the prize is still payable.`);
  const L = ledgerFor(s, e, payDate);
  if (adjusted > L.arrears) throw bad(`The winner owes only ${rs(L.arrears)}, so no more than that can be kept back.`);
  const reference = str(b, 'reference', { required: mode !== 'Cash', max: 30, label: 'cheque or UTR number' });

  const id = clientId(b);
  const adjReceiptId = adjusted > 0 ? newId() : null;
  const narration = `Prize of auction ${a.auction_no}, ${s.g.name} ticket ${a.winner_ticket_no}`;
  const stmts = [];
  if (adjReceiptId) {
    // The amount kept back pays the winner's own dues, so it shows on their account copy as a receipt.
    stmts.push(db.prepare(
      `INSERT INTO receipts (id, company_id, receipt_no, receipt_date, kind, mode, group_id, enrollment_id, person_id, amount, reason, created_by)
       VALUES (?, ?, (SELECT COALESCE(MAX(receipt_no), 0) + 1 FROM receipts WHERE company_id = ?), ?, 'adjustment', 'B.P.Adj.', ?, ?, ?, ?, ?, ?)`
    ).bind(adjReceiptId, ctx.companyId, ctx.companyId, payDate, s.g.id, e.id, e.person_id, adjusted, `Kept back from ${narration}`, ctx.user.id));
  }
  stmts.push(
    db.prepare(
      `INSERT INTO prize_payments (id, company_id, auction_id, payment_date, mode, amount, adjusted_to_dues, reference, cheque_date, paid_to, narration,
         voucher_no, adjustment_receipt_id, extra_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(voucher_no), 0) + 1 FROM prize_payments WHERE company_id = ? AND voucher_series = 'BPY'), ?, ?, ?)`
    ).bind(id, ctx.companyId, a.id, payDate, mode, amount, adjusted, reference, date(b, 'cheque_date'), str(b, 'paid_to') || e.person_name, str(b, 'narration', { max: 400 }) || narration,
      ctx.companyId, adjReceiptId, extra(b), ctx.user.id),
    ...voucherStatements(db, ctx, {
      series: 'BPY', date: payDate, sourceTable: 'prize_payments', sourceId: id, narration,
      lines: [
        { code: AC.bidPayable, dr: amount + adjusted, group_id: s.g.id, enrollment_id: e.id },
        { code: cashOrBank(mode), cr: amount },
        { code: AC.held, cr: adjusted, group_id: s.g.id, enrollment_id: e.id },
      ],
    }),
    auditStatement(db, ctx, 'create', 'prize_payments', id, `Prize payment ${rs(amount)} paid, ${rs(adjusted)} kept back: ${narration}`, null, { amount, adjusted, mode, payment_date: payDate }),
  );
  await db.batch(stmts);
  const saved = await db.prepare('SELECT voucher_series, voucher_no FROM prize_payments WHERE id = ?').bind(id).first();
  return json({ id, voucher: `${saved.voucher_series} ${saved.voucher_no}`, still_payable: remaining - amount - adjusted }, 201);
}

async function cancelPrizePayment({ request, env, ctx, params }) {
  requirePerm(ctx, 'cancelRc', 'edit');
  requirePerm(ctx, 'payable', 'edit');
  const db = env.DB;
  const p = await db.prepare('SELECT * FROM prize_payments WHERE company_id = ? AND id = ?').bind(ctx.companyId, params.id).first();
  if (!p) throw notFound('Prize payment');
  if (p.cancelled) throw conflict('This payment is already cancelled.');
  const reason = str(await readBody(request), 'reason', { required: true, max: 400, label: 'the reason for cancelling' });
  const stmts = [
    db.prepare('UPDATE prize_payments SET cancelled = 1 WHERE id = ?').bind(p.id),
    cancelVoucherStatement(db, ctx, 'prize_payments', p.id),
    auditStatement(db, ctx, 'cancel', 'prize_payments', p.id, `Prize payment ${p.voucher_series} ${p.voucher_no} cancelled: ${reason}`),
  ];
  if (p.adjustment_receipt_id) {
    stmts.push(db.prepare('UPDATE receipts SET cancelled = 1, cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?')
      .bind(new Date().toISOString(), ctx.user.id, `Prize payment cancelled: ${reason}`, p.adjustment_receipt_id));
  }
  await db.batch(stmts);
  return json({ ok: true });
}

// Details that do not change any amount (print count, SMS sent, invoice number) can be updated.
const extraOnly = (table, area, what) => async ({ request, env, ctx, params }) => {
  requirePerm(ctx, area, 'edit');
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE company_id = ? AND id = ?`).bind(ctx.companyId, params.id).first();
  if (!row) throw notFound(what);
  const b = await readBody(request);
  if (Object.keys(b).some((k) => k !== 'extra')) throw bad(`Only the extra details of a ${what.toLowerCase()} can be changed. Cancel it and enter it again to change amounts.`);
  await env.DB.prepare(`UPDATE ${table} SET extra_json = ? WHERE id = ?`).bind(extra(b), row.id).run();
  return json({ ok: true });
};

export const moneyRoutes = [
  ['POST', '/api/auctions/preview', previewAuction],
  ['POST', '/api/auctions', createAuction],
  ['POST', '/api/receipts', createReceipt],
  ['GET', '/api/receipts/:id', getReceipt],
  ['POST', '/api/receipts/:id/cancel', cancelReceipt],
  ['PATCH', '/api/receipts/:id', extraOnly('receipts', 'receipts', 'Receipt')],
  ['PATCH', '/api/auctions/:id', extraOnly('auctions', 'auctions', 'Auction')],
  ['PATCH', '/api/prize-payments/:id', extraOnly('prize_payments', 'payable', 'Prize payment')],
  ['POST', '/api/prize-payments', createPrizePayment],
  ['POST', '/api/prize-payments/:id/cancel', cancelPrizePayment],
];
