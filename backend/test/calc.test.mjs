// Checks the calculations against the worked example in docs/requirements-and-design.md.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auctionFigures, decideBid, installmentOf, ticketLedger } from '../src/lib/calc.js';

const R = 100; // paise per rupee
const g = {
  chit_amount: 500000 * R, installments: 20, commission_bp: 500, gst_bp: 1800, max_bid_bp: 4000, lottery_discount_bp: 0,
  round_dividend_down: 1, dividend_timing: 'same', prized_pays: 'reduced', no_auction_installments: 0,
  late_fee_nps_bp: 200, late_fee_ps_bp: 200, late_fee_basis: 'year', enrolment_fee: 0, start_date: '2026-01-01',
};

test('worked example: auction figures', () => {
  const f = auctionFigures(g, 100000 * R);
  assert.equal(installmentOf(g), 25000 * R);
  assert.equal(f.commission, 25000 * R);
  assert.equal(f.bid_payable, 400000 * R);
  assert.equal(f.gst, 4500 * R);
  assert.equal(f.net_prize, 395500 * R);
  assert.equal(f.dividend_pool, 75000 * R);
  assert.equal(f.dividend_per_ticket, 3750 * R);
  assert.equal(f.net_payable_per_ticket, 21250 * R);
});

// The document shows Rs 35, rounded for display; the exact figure (kept to the paisa, as in the prototype) is Rs 34.93.
test('worked example: late fee on Rs 21,250 for 30 days at 2% a year', () => {
  const a = { auction_no: 1, auction_date: '2026-01-10', due_date: '2026-01-10', dividend_per_ticket: 3750 * R, winner_enrollment_id: 'other' };
  const L = ticketLedger(g, [a], { id: 'e1' }, [], '2026-02-09');
  assert.equal(L.arrears, 21250 * R);
  assert.equal(L.penalty_accrued, 3493);
});

test('bid limits', () => {
  assert.match(decideBid(g, 1, 'bidding', 20000 * R).error, /at least the commission/);
  assert.match(decideBid(g, 1, 'bidding', 200001 * R).error, /ceiling/);
  assert.equal(decideBid(g, 1, 'bidding', 200000 * R).bid, 200000 * R);
  assert.equal(decideBid(g, 1, 'lottery').bid, 25000 * R);
  assert.equal(decideBid({ ...g, no_auction_installments: 1 }, 1, 'bidding', 100000 * R).bid, 25000 * R);
});

test('receipts: chosen installments first, then oldest, then advance', () => {
  const auctions = [1, 2].map((n) => ({ auction_no: n, auction_date: `2026-0${n}-10`, dividend_per_ticket: 3750 * R, winner_enrollment_id: 'x' + n }));
  const L = ticketLedger(g, auctions, { id: 'e1' }, [{ receipt_date: '2026-02-11', receipt_no: 1, amount: 50000 * R, insts: [2] }], '2026-02-11');
  assert.equal(L.rows[1].paid, 21250 * R);
  assert.equal(L.rows[0].paid, 21250 * R);
  assert.equal(L.advance, 7500 * R);
  assert.equal(L.balance, -7500 * R);
});

test('prized subscriber pays full installment when the group says so', () => {
  const gf = { ...g, prized_pays: 'full' };
  const auctions = [1, 2].map((n) => ({ auction_no: n, auction_date: `2026-0${n}-10`, dividend_per_ticket: 3750 * R, winner_enrollment_id: n === 1 ? 'e1' : 'x' }));
  const L = ticketLedger(gf, auctions, { id: 'e1' }, [], '2026-02-10');
  assert.equal(L.rows[0].due, 21250 * R); // installment of the month it won
  assert.equal(L.rows[1].due, 25000 * R); // after winning: full
});

test('dividend from the next month', () => {
  const gn = { ...g, dividend_timing: 'next' };
  const L = ticketLedger(gn, [{ auction_no: 1, auction_date: '2026-01-10', dividend_per_ticket: 3750 * R, winner_enrollment_id: 'x' }], { id: 'e1' }, [], '2026-01-11');
  assert.deepEqual(L.rows.map((r) => [r.no, r.due]), [[1, 25000 * R], [2, 21250 * R]]);
});
