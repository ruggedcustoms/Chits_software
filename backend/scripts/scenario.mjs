// Full test run through the API: sets up a test company, runs one group through four
// auctions with receipts and prize payments, then checks every report, the accounts
// and the audit trail against figures worked out here independently.
//
//   API_URL=http://localhost:8787 SETUP_KEY=... node scripts/scenario.mjs
//
// Uses made-up people only. Saves the test logins to test-logins.local.txt, or to
// test-logins.dev.local.txt when run against localhost (neither is committed).

import { writeFileSync } from 'node:fs';

const BASE = (process.env.API_URL || 'http://localhost:8787').replace(/\/$/, '');
const SETUP_KEY = process.env.SETUP_KEY;
if (!SETUP_KEY) throw new Error('Set SETUP_KEY.');
const AS_OF = '2026-10-12';
const R = 100; // paise per rupee
const rs = (p) => 'Rs ' + (p / R).toLocaleString('en-IN', { maximumFractionDigits: 2 });

let checks = 0;
const failures = [];
function check(label, ok, detail = '') {
  checks++;
  if (!ok) failures.push(`${label} ${detail}`);
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}${ok ? '' : ' ' + detail}`);
}
const eq = (label, got, want) => check(label, got === want, `(got ${got}, want ${want})`);

async function call(method, path, body, token, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function ok(method, path, body, token, extra) {
  const r = await call(method, path, body, token, extra);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const pw = () => 'Test' + crypto.randomUUID().replace(/-/g, '').slice(0, 12) + '9';

// ------------------------------------------------------------------ setup
console.log(`\nAPI: ${BASE}\n\n1. Company, staff and members`);
eq('health', (await ok('GET', '/api/health')).ok, true);
eq('setup refused without the key', (await call('POST', '/api/setup', { company_name: 'x' })).status, 403);

const logins = { owner: pw(), manager: pw(), accountant: pw(), agent: pw(), agent2: pw(), viewer: pw() };
const co = await ok('POST', '/api/setup', { company_name: 'Test Chits Pvt Ltd', admin_name: 'Test Owner', username: 'owner', password: logins.owner, city: 'Bengaluru', state: 'Karnataka' }, null, { 'x-setup-key': SETUP_KEY });
const login = async (username) => (await ok('POST', '/api/auth/login', { company_id: co.company_id, username, password: logins[username] })).token;
const owner = await login('owner');
eq('unsigned request refused', (await call('GET', '/api/groups')).status, 401);

const persons = {};
const person = async (key, name, roles, mobile) =>
  (persons[key] = (await ok('POST', '/api/persons', { name, roles, relation_type: 'S/o', relation_name: 'Test Parent', addresses: { residential: { city: 'Bengaluru', state: 'Karnataka', pin: '560001', mobile } } }, owner)).id);
await person('agentA', 'Test Agent A', ['Collection agent', 'Business agent'], '9100000001');
await person('agentB', 'Test Agent B', ['Collection agent'], '9100000002');
for (let t = 1; t <= 20; t++) await person('m' + t, `Test Member ${String(t).padStart(2, '0')}`, ['Member'], '92000000' + String(t).padStart(2, '0'));
eq('bad PAN refused', (await call('POST', '/api/persons', { name: 'x', pan: '123' }, owner)).status, 400);

for (const [username, role, personId] of [['manager', 'Manager'], ['accountant', 'Accountant'], ['agent', 'Collection agent', persons.agentA], ['agent2', 'Collection agent', persons.agentB], ['viewer', 'Viewer']]) {
  await ok('POST', '/api/users', { name: `Test ${role}`, username, password: logins[username], role, person_id: personId }, owner);
}
const T = {};
for (const u of ['manager', 'accountant', 'agent', 'agent2', 'viewer']) T[u] = await login(u);

// ------------------------------------------------------------------ group and tickets
console.log('\n2. Group and enrollment (worked example: Rs 5,00,000, 20 tickets, 5% commission, 18% GST)');
eq('accountant cannot create a group', (await call('POST', '/api/groups', {}, T.accountant)).status, 403);
const grp = (await ok('POST', '/api/groups', {
  name: 'TEST-20', chit_amount: 500000 * R, installments: 20, start_date: '2026-06-01', termination_date: '2028-01-31',
  commission_bp: 500, max_bid_bp: 4000, gst_bp: 1800, late_fee_nps_bp: 200, late_fee_ps_bp: 200, late_fee_basis: 'year',
  enrolment_fee: 500 * R, auction_method: 'both', auction_day: 10, pso_no: 'TEST/PSO/1',
}, T.manager)).id;

const enr = {};
for (let t = 1; t <= 19; t++) {
  enr[t] = (await ok('POST', '/api/enrollments', { group_id: grp, ticket_no: t, person_id: persons['m' + t], collection_agent_id: t <= 14 ? persons.agentA : persons.agentB, business_agent_id: persons.agentA, nominee_name: 'Test Nominee', nominee_relation: 'Spouse' }, T.manager)).id;
}
// Ticket 20 is held by a member who never pays (no company ticket in this group; see section 8).
enr[20] = (await ok('POST', '/api/enrollments', { group_id: grp, ticket_no: 20, person_id: persons.m20 }, T.manager)).id;
eq('ticket taken twice refused', (await call('POST', '/api/enrollments', { group_id: grp, ticket_no: 3, person_id: persons.m1 }, T.manager)).status, 409);
eq('ticket outside the group refused', (await call('POST', '/api/enrollments', { group_id: grp, ticket_no: 21, person_id: persons.m1 }, T.manager)).status, 400);

// ------------------------------------------------------------------ auctions
console.log('\n3. Auctions');
const plan = [
  { no: 1, date: '2026-06-10', due: '2026-06-25', ticket: 2, decided_by: 'bidding', bid: 100000 },
  { no: 2, date: '2026-07-10', due: '2026-07-25', ticket: 5, decided_by: 'bidding', bid: 90000 },
  { no: 3, date: '2026-08-10', due: '2026-08-25', ticket: 7, decided_by: 'lottery' },
  { no: 4, date: '2026-09-10', due: '2026-09-25', ticket: 9, decided_by: 'bidding', bid: 80000 },
];
// Independent figures in rupees: commission 25,000 and GST 4,500 every month.
for (const a of plan) {
  const bid = a.bid ?? 25000;
  a.div = Math.floor((bid - 25000) / 20);
  a.net = 25000 - a.div;
  a.netPrize = 500000 - bid - 4500;
}
eq('bid below commission refused', (await call('POST', '/api/auctions', { group_id: grp, auction_date: '2026-06-10', winner_ticket_no: 2, bid: 20000 * R }, T.manager)).status, 400);
eq('bid above 40% ceiling refused', (await call('POST', '/api/auctions', { group_id: grp, auction_date: '2026-06-10', winner_ticket_no: 2, bid: 200001 * R }, T.manager)).status, 400);
eq('agent cannot record an auction', (await call('POST', '/api/auctions', { group_id: grp }, T.agent)).status, 403);

const auctionIds = {};
for (const a of plan) {
  const r = await ok('POST', '/api/auctions', { group_id: grp, auction_date: a.date, due_date: a.due, winner_ticket_no: a.ticket, decided_by: a.decided_by, bid: a.bid && a.bid * R }, T.manager);
  auctionIds[a.no] = r.id;
  eq(`auction ${a.no}: dividend per ticket ${rs(a.div * R)}`, r.dividend_per_ticket, a.div * R);
  eq(`auction ${a.no}: net payable ${rs(a.net * R)}`, r.net_payable_per_ticket, a.net * R);
  eq(`auction ${a.no}: net prize ${rs(a.netPrize * R)}`, r.net_prize, a.netPrize * R);
}
eq('auction 1 matches worked example: GST Rs 4,500', (await ok('GET', `/api/reports/auction-chart?group_id=${grp}`, null, owner)).rows[0].gst, 4500 * R);
eq('a ticket cannot win twice', (await call('POST', '/api/auctions', { group_id: grp, auction_date: '2026-10-10', winner_ticket_no: 2, bid: 90000 * R }, T.manager)).status, 409);

// ------------------------------------------------------------------ receipts
console.log('\n4. Receipts');
const sent = []; // what we expect to stay in the books
const receipt = async (token, t, date, amount, insts, extra = {}) => {
  const body = { group_id: grp, ticket_no: t, receipt_date: date, mode: 'Cash', amount: amount * R, insts, ...extra };
  const r = await ok('POST', '/api/receipts', body, token);
  sent.push({ id: r.id, t, mode: body.mode, amount: amount * R, penalty: extra.penalty || 0, enrol: extra.enrolment_fee || 0 });
  return r;
};
const payDates = ['2026-06-20', '2026-07-20', '2026-08-20', '2026-09-20'];
const modes = ['Cash', 'UPI', 'Cheque', 'RTGS/NEFT'];
const regular = [1, 5, 7, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19];
for (const t of regular) {
  for (let k = 0; k < 4; k++) {
    const mode = modes[(t + k) % 4];
    const token = t >= 11 && t <= 14 ? T.agent : t >= 15 ? T.agent2 : T.accountant;
    await receipt(token, t, payDates[k], plan[k].net, [k + 1], { mode, cheque_no: mode === 'Cheque' ? `CHQ${t}${k}` : undefined, cheque_bank: mode === 'Cheque' ? 'Test Bank' : undefined, enrolment_fee: k === 0 ? 500 * R : 0 });
  }
}
// Ticket 2 won auction 1; installment 1 is kept back from its prize, then it pays 2 to 4.
for (let k = 1; k < 4; k++) await receipt(T.accountant, 2, payDates[k], plan[k].net, [k + 1]);
// Ticket 3 pays only installment 1. Ticket 4 pays nothing.
await receipt(T.accountant, 3, '2026-06-20', plan[0].net, [1]);
// Ticket 6 pays Rs 50,000 at once: installment 1, and the rest is held as advance.
await receipt(T.accountant, 6, '2026-06-20', 50000, [1], { enrolment_fee: 500 * R });
await receipt(T.accountant, 6, '2026-08-20', 18000, [3]);
await receipt(T.accountant, 6, '2026-09-20', plan[3].net, [4]);
// Ticket 8 pays all four, plus one duplicate entry that is cancelled.
for (let k = 0; k < 4; k++) await receipt(T.accountant, 8, payDates[k], plan[k].net, [k + 1], k === 0 ? { enrolment_fee: 500 * R } : {});
const dup = await receipt(T.accountant, 8, '2026-06-21', plan[0].net, [1]);
// Ticket 10 pays installment 1 late, with Rs 300 penalty, then 2 to 4 on time.
await receipt(T.accountant, 10, '2026-08-05', plan[0].net, [1], { penalty: 300 * R, enrolment_fee: 500 * R });
for (let k = 1; k < 4; k++) await receipt(T.accountant, 10, payDates[k], plan[k].net, [k + 1]);

eq('agent cannot take money for a ticket not assigned to them', (await call('POST', '/api/receipts', { group_id: grp, ticket_no: 15, mode: 'Cash', amount: 100 }, T.agent)).status, 403);
eq('viewer cannot record a receipt', (await call('POST', '/api/receipts', { group_id: grp, ticket_no: 1, mode: 'Cash', amount: 100 }, T.viewer)).status, 403);
eq('cheque without number refused', (await call('POST', '/api/receipts', { group_id: grp, ticket_no: 1, mode: 'Cheque', amount: 100 }, T.accountant)).status, 400);
eq('future-dated receipt refused', (await call('POST', '/api/receipts', { group_id: grp, ticket_no: 1, mode: 'Cash', amount: 100, receipt_date: '2099-01-01' }, T.accountant)).status, 400);
eq('agent cannot cancel a receipt', (await call('POST', `/api/receipts/${dup.id}/cancel`, { reason: 'x' }, T.agent)).status, 403);
await ok('POST', `/api/receipts/${dup.id}/cancel`, { reason: 'Entered twice by mistake' }, T.accountant);
sent.splice(sent.findIndex((x) => x.id === dup.id), 1);
eq('cancelling twice refused', (await call('POST', `/api/receipts/${dup.id}/cancel`, { reason: 'x' }, T.accountant)).status, 409);

// ------------------------------------------------------------------ prize payments
console.log('\n5. Prize payments');
const keptBack = plan[0].net * R; // ticket 2 owes installment 1 when its prize is paid
const p1 = await ok('POST', '/api/prize-payments', { auction_id: auctionIds[1], payment_date: '2026-06-26', mode: 'RTGS/NEFT', amount: plan[0].netPrize * R - keptBack, adjusted_to_dues: keptBack, reference: 'UTR0001' }, T.accountant);
eq('auction 1 prize fully paid', p1.still_payable, 0);
const p2 = await ok('POST', '/api/prize-payments', { auction_id: auctionIds[2], payment_date: '2026-07-21', mode: 'Cheque', amount: 200000 * R, reference: '000123' }, T.accountant);
eq('auction 2 prize partly paid', p2.still_payable, (plan[1].netPrize - 200000) * R);
eq('overpaying a prize refused', (await call('POST', '/api/prize-payments', { auction_id: auctionIds[2], mode: 'Cash', amount: 300000 * R }, T.accountant)).status, 400);
eq('agent cannot pay a prize', (await call('POST', '/api/prize-payments', { auction_id: auctionIds[3], mode: 'Cash', amount: 100 }, T.agent)).status, 403);

// ------------------------------------------------------------------ reports
console.log('\n6. Reports');
const allNet = plan.reduce((s, a) => s + a.net, 0) * R; // what every NPS ticket owes after 4 auctions
const acct = async (t) => ok('GET', `/api/enrollments/${enr[t]}/account?as_of=${AS_OF}`, null, owner);
for (const t of [1, 2, 6, 8, 10]) {
  const L = await acct(t);
  eq(`ticket ${t}: fully paid, balance 0`, L.balance, 0);
}
const L3 = await acct(3);
eq('ticket 3: arrears = installments 2 to 4', L3.arrears, allNet - plan[0].net * R);
const L4 = await acct(4);
eq('ticket 4: arrears = all four installments', L4.arrears, allNet);
eq('ticket 4: enrolment fee still due', L4.enrolment_fee_due, 500 * R);
// Late fee at 2% a year by the day, worked out here independently.
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fee = (amt, due) => Math.round((amt * 200 / 10000) * days(due, AS_OF) / 365);
eq('ticket 4: late fee', L4.penalty_due, plan.reduce((s, a) => s + fee(a.net * R, a.due), 0));
eq('ticket 3: late fee', L3.penalty_due, plan.slice(1).reduce((s, a) => s + fee(a.net * R, a.due), 0));
eq('ticket 2: shown as prized (PS)', (await acct(2)).prized, true);

const out = await ok('GET', `/api/reports/outstanding?group_id=${grp}&as_of=${AS_OF}`, null, owner);
eq('outstanding lists only tickets 3, 4 and 20', out.rows.map((r) => r.ticket_no).join(','), '3,4,20');
eq('outstanding total arrears', out.totals.arrears, L3.arrears + 2 * L4.arrears);
const agentOut = await ok('GET', `/api/reports/outstanding?as_of=${AS_OF}&only_dues=0`, null, T.agent2);
eq('agent B sees only tickets 15 to 19', agentOut.rows.map((r) => r.ticket_no).join(','), '15,16,17,18,19');

const col = await ok('GET', '/api/reports/collections?from=2026-06-01&to=2026-10-12', null, owner);
const sentTotal = sent.reduce((s, x) => s + x.amount + x.penalty + x.enrol, 0);
eq('collection register: receipt count (incl. 1 kept-back adjustment)', col.rows.length, sent.length + 1);
eq('collection register: total', col.totals.total, sentTotal + keptBack);
eq('collection register: cancelled receipt left out', col.rows.some((r) => r.id === dup.id), false);
eq('collection register: penalty', col.totals.penalty, 300 * R);
eq('collection register: enrolment fees', col.totals.enrolment_fee, sent.filter((x) => x.enrol).length * 500 * R);
eq('collection register by mode adds up', Object.values(col.by_mode).reduce((s, x) => s + x, 0), col.totals.total);

const prizes = await ok('GET', `/api/reports/prize-payments?group_id=${grp}`, null, owner);
eq('prize report: still payable', prizes.totals.balance, plan.reduce((s, a) => s + a.netPrize, 0) * R - plan[0].netPrize * R - 200000 * R);

const chart = await ok('GET', `/api/reports/auction-chart?group_id=${grp}`, null, owner);
eq('auction chart: total commission', chart.totals.commission, 4 * 25000 * R);

// ------------------------------------------------------------------ accounts
console.log('\n7. Accounts');
const tb = await ok('GET', `/api/reports/trial-balance?as_on=${AS_OF}`, null, T.accountant);
const bal = (code) => { const r = tb.rows.find((x) => x.code === code); return r ? r.debit - r.credit : 0; };
eq('trial balance balances', tb.balanced, true);
const cashIn = sent.reduce((s, x) => s + x.amount + x.penalty + x.enrol, 0);
const paidOut = plan[0].netPrize * R - keptBack + 200000 * R;
eq('cash + bank = money in - prizes paid', bal('1001') + bal('1002'), cashIn - paidOut);
eq('commission income', -bal('3001'), 4 * 25000 * R);
eq('GST payable', -bal('2005'), 4 * 4500 * R);
eq('penalty income', -bal('3002'), 300 * R);
eq('enrolment fee income', -bal('3003'), sent.filter((x) => x.enrol).length * 500 * R);
eq('bid payable = prizes still owed', -bal('2002'), prizes.totals.balance);
const subs = sent.reduce((s, x) => s + x.amount, 0) + keptBack;
const used = plan.reduce((s, a) => s + (500000 - (a.bid ?? 25000)) + 25000, 0) * R;
eq('subscriptions held = collected - (prize + commission)', -bal('2001'), subs - used);
const db = await ok('GET', '/api/reports/day-book?date=2026-06-20', null, T.accountant);
eq('day book of 20 Jun balances', db.totals.debit, db.totals.credit);
eq('viewer cannot see the audit log', (await call('GET', '/api/audit', null, T.viewer)).status, 403);

// ------------------------------------------------------------------ company ticket and auction 1
console.log('\n8. Auction 1 of a group with a company ticket');
const lockG = (await ok('POST', '/api/groups', { name: 'LOCK-4', chit_amount: 100000 * R, installments: 4, start_date: '2026-06-01', commission_bp: 500, max_bid_bp: 4000 }, T.manager)).id;
await ok('POST', '/api/enrollments', { group_id: lockG, ticket_no: 1, person_id: persons.m1 }, T.manager);
await ok('POST', '/api/enrollments', { group_id: lockG, ticket_no: 4, is_company: true }, T.manager);
eq('a member cannot take auction 1', (await call('POST', '/api/auctions', { group_id: lockG, auction_date: '2026-06-10', winner_ticket_no: 1, decided_by: 'bidding', bid: 10000 * R }, T.manager)).status, 400);
eq('the company ticket must be "company decided"', (await call('POST', '/api/auctions', { group_id: lockG, auction_date: '2026-06-10', winner_ticket_no: 4, decided_by: 'bidding', bid: 10000 * R }, T.manager)).status, 400);
const co1 = await ok('POST', '/api/auctions', { group_id: lockG, auction_date: '2026-06-10', winner_ticket_no: 4, decided_by: 'company' }, T.manager);
check('auction 1 taken by the company at the commission, no dividend', co1.bid === 5000 * R && co1.dividend_per_ticket === 0, `(bid ${co1.bid}, dividend ${co1.dividend_per_ticket})`);
eq('auction 2 is open to members again', (await call('POST', '/api/auctions', { group_id: lockG, auction_date: '2026-07-10', winner_ticket_no: 1, decided_by: 'bidding', bid: 10000 * R }, T.manager)).status, 201);

// ------------------------------------------------------------------ audit and security
console.log('\n9. Audit trail and sign-in security');
const audit = await ok('GET', '/api/audit?limit=1000', null, owner);
const count = (entity, action) => audit.filter((a) => a.entity === entity && a.action === action).length;
eq('audit: every receipt recorded', count('receipts', 'create'), sent.length + 1);
eq('audit: cancellation recorded', count('receipts', 'cancel'), 1);
eq('audit: every auction recorded', count('auctions', 'create'), 6);
eq('audit: prize payments recorded', count('prize_payments', 'create'), 2);
eq('audit: enrollments recorded', count('enrollments', 'create'), 22);
check('audit: shows who did it', audit.every((a) => a.user), '(a row has no user)');

for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { company_id: co.company_id, username: 'viewer', password: 'wrong-password-1' });
eq('5 wrong passwords lock the login', (await call('POST', '/api/auth/login', { company_id: co.company_id, username: 'viewer', password: logins.viewer })).status, 423);
const viewerId = (await ok('GET', '/api/users', null, owner)).find((u) => u.username === 'viewer').id;
await ok('PATCH', `/api/users/${viewerId}`, { unlock: true }, owner);
eq('owner can unlock it', (await call('POST', '/api/auth/login', { company_id: co.company_id, username: 'viewer', password: logins.viewer })).status, 200);
await ok('POST', '/api/auth/logout', null, T.manager);
eq('signed-out session no longer works', (await call('GET', '/api/groups', null, T.manager)).status, 401);

// ------------------------------------------------------------------ member app
console.log('\n10. Member app');
const mcall = (method, path, body, token) => call(method, path, body, token);
eq('viewer cannot issue an app login', (await call('POST', '/api/member-logins', { person_id: persons.m2 }, T.viewer)).status, 403);
eq('no login yet: sign-in refused', (await call('POST', '/api/member/login', { company_id: co.company_id, username: 'M2', password: '123456' })).status, 401);
const iss2 = await ok('POST', '/api/member-logins', { person_id: persons.m2 }, owner);
check('login issued: username is the member number, 6-digit password', /^[A-Z]*0*\d+$/.test(iss2.username) && /^\d{6}$/.test(iss2.password), JSON.stringify(iss2));
const ml = await ok('POST', '/api/member/login', { company_id: co.company_id, username: iss2.username.toLowerCase(), password: iss2.password });
eq('first sign-in must change the password', ml.must_change, true);
eq('nothing shown until the password is changed', (await mcall('GET', '/api/member/home', null, ml.token)).status, 403);
eq('wrong current password refused', (await mcall('POST', '/api/member/password', { current_password: '000000', new_password: 'Garden42' }, ml.token)).status, 400);
eq('too easy a password refused', (await mcall('POST', '/api/member/password', { current_password: iss2.password, new_password: '111111' }, ml.token)).status, 400);
await ok('POST', '/api/member/password', { current_password: iss2.password, new_password: 'Garden42' }, ml.token);
eq('temporary password stops working', (await call('POST', '/api/member/login', { company_id: co.company_id, username: iss2.username, password: iss2.password })).status, 401);
const m2 = await ok('POST', '/api/member/login', { company_id: co.company_id, username: iss2.username, password: 'Garden42' });
eq('new password works, no change needed', m2.must_change, false);
const h2 = await ok('GET', '/api/member/home', null, m2.token);
check('member sees only their own ticket', h2.chits.length === 1 && h2.chits[0].group === 'TEST-20' && h2.chits[0].ticket === 2, JSON.stringify(h2.chits.map((c) => [c.group, c.ticket])));
eq('member: won auction 1', h2.chits[0].won, 1);
eq('member: net prize as recorded', h2.chits[0].prize.netPrize, plan[0].netPrize);
eq('member: one installment row per auction', h2.chits[0].rows.length, 4);
eq('member: all auction results listed', h2.chits[0].auc.length, 4);
check('member: receipts are only for their ticket', h2.receipts.every((r) => r.ticket === 2 && r.group === 'TEST-20'), JSON.stringify(h2.receipts.map((r) => r.ticket)));
eq('member: name', h2.member.name, 'Test Member 02');

const iss1 = await ok('POST', '/api/member-logins', { person_id: persons.m1 }, owner);
const m1t = (await ok('POST', '/api/member/login', { company_id: co.company_id, username: iss1.username, password: iss1.password })).token;
await ok('POST', '/api/member/password', { current_password: iss1.password, new_password: 'River77x' }, m1t);
const h1 = await ok('GET', '/api/member/home', null, m1t);
check('member with two chits sees both, nobody else\'s', h1.chits.length === 2 && h1.chits.every((c) => c.ticket === 1), JSON.stringify(h1.chits.map((c) => [c.group, c.ticket])));

eq('staff token does not open the member app', (await mcall('GET', '/api/member/home', null, owner)).status, 401);
eq('member token does not open office data', (await call('GET', '/api/groups', null, m2.token)).status, 401);

const bulk = await ok('POST', '/api/member-logins/bulk', null, owner);
check('bulk: every other enrolled member gets a login', bulk.issued.length === 18 && bulk.remaining === 0, `(issued ${bulk.issued.length}, remaining ${bulk.remaining})`);
eq('logins listed', (await ok('GET', '/api/member-logins', null, owner)).length, 20);

await ok('PATCH', `/api/member-logins/${persons.m1}`, { active: false }, owner);
eq('switched-off login: open session ends', (await mcall('GET', '/api/member/home', null, m1t)).status, 401);
eq('switched-off login: cannot sign in', (await call('POST', '/api/member/login', { company_id: co.company_id, username: iss1.username, password: 'River77x' })).status, 403);

for (let i = 0; i < 5; i++) await call('POST', '/api/member/login', { company_id: co.company_id, username: iss2.username, password: 'wrong-pin' });
eq('5 wrong passwords lock the member login', (await call('POST', '/api/member/login', { company_id: co.company_id, username: iss2.username, password: 'Garden42' })).status, 423);
const reset = await ok('POST', '/api/member-logins', { person_id: persons.m2 }, owner);
const after = await ok('POST', '/api/member/login', { company_id: co.company_id, username: iss2.username, password: reset.password });
eq('office reset unlocks and asks for a new password', after.must_change, true);
eq('reset ends the old sessions', (await mcall('GET', '/api/member/home', null, m2.token)).status, 401);
await ok('POST', '/api/member/logout', null, after.token);
eq('signed-out member session no longer works', (await mcall('POST', '/api/member/password', {}, after.token)).status, 401);

// ------------------------------------------------------------------ summary
const lines = [`API: ${BASE}`, `Company code: ${co.company_id}`, ...Object.entries(logins).map(([u, p]) => `${u.padEnd(10)} ${p}`)];
const loginsFile = /localhost|127\.0\.0\.1/.test(BASE) ? 'test-logins.dev.local.txt' : 'test-logins.local.txt';
writeFileSync(new URL('../' + loginsFile, import.meta.url), lines.join('\n') + '\n');
console.log(`\n${checks - failures.length} of ${checks} checks passed.`);
console.log(`Test logins saved to backend/${loginsFile} (company code ${co.company_id}).`);
if (failures.length) {
  console.log('\nFailed:\n' + failures.map((f) => '  ' + f).join('\n'));
  process.exit(1);
}
