// Chit calculations, in whole paise. These follow the prototype (public/apps/office.html:
// chitInst, commAmt, calcAuction, ledger) and the rules in docs/requirements-and-design.md.
// Pure functions: no database access, so they can be tested on their own.

const RUPEE = 100;
const roundRupee = (p) => Math.round(p / RUPEE) * RUPEE;
const pct = (amount, bp) => (amount * bp) / 10000;

// Rule 1: installment = chit amount / installments, unless a fixed amount is set. Whole rupees.
export const installmentOf = (g) => (g.installment_amount > 0 ? g.installment_amount : roundRupee(g.chit_amount / g.installments));

// Rule 2: commission = chit amount x commission %. Whole rupees.
export const commissionOf = (g) => roundRupee(pct(g.chit_amount, g.commission_bp));

export const maxBidOf = (g) => Math.floor(pct(g.chit_amount, g.max_bid_bp));

// Rule 3, lottery and company decisions: the larger of commission and the lottery discount.
export const lotteryBidOf = (g) => Math.max(commissionOf(g), roundRupee(pct(g.chit_amount, g.lottery_discount_bp)));

// Rules 2 to 7 for one auction.
export function auctionFigures(g, bid, gstBp = g.gst_bp) {
  const commission = commissionOf(g);
  const gst = roundRupee(pct(commission, gstBp));
  const installment = installmentOf(g);
  const pool = bid - commission;
  let dividend = Math.max(0, pool) / g.installments;
  dividend = g.round_dividend_down ? Math.floor(dividend / RUPEE) * RUPEE : Math.round(dividend);
  const bidPayable = g.chit_amount - bid;
  return {
    bid,
    commission,
    gst_bp: gstBp,
    gst,
    bid_payable: bidPayable,
    net_prize: bidPayable - gst,
    dividend_pool: pool,
    dividend_per_ticket: dividend,
    net_payable_per_ticket: installment - dividend,
  };
}

// Works out the bid for an auction and checks it against the group's rules.
// Returns { bid } or { error }.
export function decideBid(g, auctionNo, decidedBy, bidInput) {
  const commission = commissionOf(g);
  if (auctionNo <= (g.no_auction_installments || 0)) return { bid: commission, noAuction: true };
  if (decidedBy === 'company') return { bid: lotteryBidOf(g) };
  // A lottery uses the lottery discount unless a bid is given (the office screen lets staff enter it).
  if (decidedBy === 'lottery' && (bidInput == null || bidInput === '')) return { bid: lotteryBidOf(g) };
  if (!Number.isSafeInteger(bidInput)) return { error: 'Enter the winning bid in paise.' };
  if (bidInput < commission) return { error: `Bid must be at least the commission (${rs(commission)}).` };
  if (bidInput > maxBidOf(g)) return { error: `Bid cannot be more than the ceiling of ${g.max_bid_bp / 100}% (${rs(maxBidOf(g))}).` };
  return { bid: bidInput };
}

export const rs = (p) => 'Rs ' + (p / RUPEE).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Whole months late, counting a started month (prototype: per-month late fee).
export function monthsLate(from, to) {
  if (to <= from) return 0;
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) + (d2 > d1 ? 1 : 0));
}
const daysLate = (from, to) => (to > from ? Math.round((Date.parse(to) - Date.parse(from)) / 864e5) : 0);

// The account copy of one ticket: what fell due, what was paid, and the late fee.
//   g          group row
//   auctions   active auctions of the group, any order
//   e          the enrollment
//   receipts   receipts of the ticket that are not cancelled, each with amount and insts (chosen installment numbers)
//   asOf       'YYYY-MM-DD' for the late fee
export function ticketLedger(g, auctions, e, receipts, asOf) {
  const inst = installmentOf(g);
  const sorted = auctions.slice().sort((a, b) => a.auction_no - b.auction_no);
  const won = sorted.find((a) => a.winner_enrollment_id === e.id);
  const wonNo = won ? won.auction_no : null;

  const row = (no, dueDate, dividend) => {
    const ps = wonNo != null && no > wonNo;
    const full = ps && g.prized_pays === 'full';
    return { no, due_date: dueDate, dividend: full ? 0 : dividend, due: full ? inst : inst - dividend, paid: 0, ps };
  };

  // Rule 8. 'next': installment 1 is due at the start with no dividend, and auction k sets installment k+1.
  let rows;
  if (g.dividend_timing === 'next') {
    rows = [];
    if (sorted.length || g.start_date <= asOf) rows.push(row(1, g.start_date, 0));
    for (const a of sorted) if (a.auction_no + 1 <= g.installments) rows.push(row(a.auction_no + 1, a.due_date || a.auction_date, a.dividend_per_ticket));
  } else {
    rows = sorted.map((a) => row(a.auction_no, a.due_date || a.auction_date, a.dividend_per_ticket));
  }

  // Rule 10: chosen installments first, the rest to the oldest unpaid, then advance.
  const rs_ = receipts.slice().sort((a, b) => a.receipt_date.localeCompare(b.receipt_date) || a.receipt_no - b.receipt_no);
  const leftovers = [];
  for (const r of rs_) {
    let left = r.amount;
    for (const k of (r.insts || []).slice().sort((a, b) => a - b)) {
      const target = rows.find((x) => x.no === k);
      if (!target) continue;
      const take = Math.min(left, target.due - target.paid);
      if (take > 0) {
        target.paid += take;
        left -= take;
      }
    }
    if (left > 0) leftovers.push(left);
  }
  for (const target of rows) {
    for (let i = 0; i < leftovers.length && target.paid < target.due; i++) {
      const take = Math.min(leftovers[i], target.due - target.paid);
      target.paid += take;
      leftovers[i] -= take;
    }
  }
  const advance = leftovers.reduce((s, x) => s + x, 0);

  // Rule 9: late fee on what is still unpaid after its due date. PS and NPS have their own rates.
  let penalty = 0;
  const perYear = g.late_fee_basis === 'year';
  for (const r of rows) {
    const rateBp = r.ps ? g.late_fee_ps_bp : g.late_fee_nps_bp;
    const unpaid = r.due - r.paid;
    if (!r.due_date || !(rateBp > 0) || unpaid <= 0 || r.due_date >= asOf) continue;
    const fee = perYear ? (pct(unpaid, rateBp) * daysLate(r.due_date, asOf)) / 365 : pct(unpaid, rateBp) * monthsLate(r.due_date, asOf);
    r.late_fee = Math.round(fee);
    penalty += r.late_fee;
  }

  const totalDue = rows.reduce((s, r) => s + r.due, 0);
  const totalPaid = receipts.reduce((s, r) => s + r.amount, 0);
  const penaltyPaid = receipts.reduce((s, r) => s + (r.penalty || 0), 0);
  const enrolPaid = receipts.reduce((s, r) => s + (r.enrolment_fee || 0), 0);
  return {
    rows,
    installment: inst,
    total_due: totalDue,
    total_paid: totalPaid,
    balance: totalDue - totalPaid,                      // negative = paid ahead
    arrears: rows.reduce((s, r) => s + Math.max(0, r.due - r.paid), 0),
    advance,
    penalty_accrued: penalty,
    penalty_paid: penaltyPaid,
    penalty_due: Math.max(0, penalty - penaltyPaid),
    enrolment_fee_due: Math.max(0, (g.enrolment_fee || 0) - enrolPaid),
    prized: wonNo != null,
    won_auction_no: wonNo,
  };
}
