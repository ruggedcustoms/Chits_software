// Members (persons), chit groups and enrollment.

import { bad, bool, conflict, date, forbidden, int, json, newId, notFound, oneOf, paise, readBody, str, todayIst } from '../lib/http.js';
import { can, ownTicketsOnly, requirePerm } from '../lib/auth.js';
import { auditStatement } from '../lib/books.js';
import { commissionOf, installmentOf } from '../lib/calc.js';
import { ledgerFor, loadGroup, loadGroupState } from '../lib/state.js';

const PERSON_ROLES = ['Member', 'Collection agent', 'Business agent', 'Guarantor'];
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// ---- persons ----

function personFields(b) {
  const pan = str(b, 'pan', { max: 10 });
  if (pan && !PAN_RE.test(pan.toUpperCase())) throw bad('PAN must look like ABCDE1234F.');
  const ifsc = str(b, 'ifsc', { max: 11 });
  if (ifsc && !IFSC_RE.test(ifsc.toUpperCase())) throw bad('IFSC must look like SBIN0001234.');
  const aadhaar = str(b, 'aadhaar_last4', { max: 4 });
  if (aadhaar && !/^\d{4}$/.test(aadhaar)) throw bad('Store only the last 4 digits of Aadhaar.');
  const roles = b.roles == null ? ['Member'] : b.roles;
  if (!Array.isArray(roles) || !roles.length || roles.some((r) => !PERSON_ROLES.includes(r))) throw bad(`Roles must be a list from: ${PERSON_ROLES.join(', ')}.`);
  return {
    title: str(b, 'title', { max: 10 }),
    name: str(b, 'name', { required: true }),
    relation_type: str(b, 'relation_type', { max: 10 }),
    relation_name: str(b, 'relation_name'),
    gender: str(b, 'gender', { max: 10 }),
    dob: date(b, 'dob', { label: 'date of birth' }),
    occupation: str(b, 'occupation'),
    employer: str(b, 'employer'),
    designation: str(b, 'designation'),
    monthly_income: paise(b, 'monthly_income'),
    pan: pan && pan.toUpperCase(),
    aadhaar_last4: aadhaar,
    gst_no: str(b, 'gst_no', { max: 15 }),
    bank_name: str(b, 'bank_name'),
    bank_account_no: str(b, 'bank_account_no', { max: 30 }),
    ifsc: ifsc && ifsc.toUpperCase(),
    roles_json: JSON.stringify(roles),
    entry_date: date(b, 'entry_date') || todayIst(),
    branch_id: str(b, 'branch_id'),
  };
}

const ADDRESS_KINDS = ['residential', 'office', 'correspondence'];
function addressStatements(db, personId, addresses) {
  if (addresses == null) return [];
  if (typeof addresses !== 'object' || Array.isArray(addresses)) throw bad('addresses must be an object keyed by residential, office or correspondence.');
  return Object.entries(addresses).map(([kind, a]) => {
    if (!ADDRESS_KINDS.includes(kind)) throw bad(`Address kind must be one of: ${ADDRESS_KINDS.join(', ')}.`);
    const mobile = str(a, 'mobile', { max: 15 });
    if (mobile && !/^[6-9]\d{9}$/.test(mobile)) throw bad('Mobile must be a 10-digit Indian number.');
    return db.prepare(
      `INSERT INTO person_addresses (person_id, kind, door, street, area, city, district, state, pin, mobile, mobile2, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (person_id, kind) DO UPDATE SET door = excluded.door, street = excluded.street, area = excluded.area, city = excluded.city,
         district = excluded.district, state = excluded.state, pin = excluded.pin, mobile = excluded.mobile, mobile2 = excluded.mobile2, email = excluded.email`
    ).bind(personId, kind, str(a, 'door'), str(a, 'street'), str(a, 'area'), str(a, 'city'), str(a, 'district'), str(a, 'state'),
      str(a, 'pin', { max: 6 }), mobile, str(a, 'mobile2', { max: 15 }), str(a, 'email'));
  });
}

async function listPersons({ env, ctx, query }) {
  requirePerm(ctx, 'members');
  const q = (query.get('q') || '').trim();
  const role = query.get('role');
  const where = ['p.company_id = ?'];
  const vals = [ctx.companyId];
  if (q) { where.push('(p.name LIKE ? OR a.mobile LIKE ? OR p.old_code = ? OR CAST(p.member_no AS TEXT) = ?)'); vals.push(`%${q}%`, `%${q}%`, q, q); }
  if (role) { where.push('p.roles_json LIKE ?'); vals.push(`%"${role}"%`); }
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.member_no, p.name, p.relation_type, p.relation_name, p.roles_json, p.active, a.mobile, a.city
       FROM persons p LEFT JOIN person_addresses a ON a.person_id = p.id AND a.kind = 'residential'
      WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 500`
  ).bind(...vals).all();
  return json(results.map((r) => ({ ...r, roles: JSON.parse(r.roles_json), roles_json: undefined })));
}

async function getPerson({ env, ctx, params }) {
  requirePerm(ctx, 'members');
  const [p, addrs, tickets] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM persons WHERE company_id = ? AND id = ?').bind(ctx.companyId, params.id),
    env.DB.prepare('SELECT * FROM person_addresses WHERE person_id = ?').bind(params.id),
    env.DB.prepare(
      `SELECT e.id, e.ticket_no, e.status, g.id AS group_id, g.name AS group_name FROM enrollments e JOIN chit_groups g ON g.id = e.group_id
        WHERE e.person_id = ? ORDER BY g.name, e.ticket_no`
    ).bind(params.id),
  ]);
  const person = p.results[0];
  if (!person) throw notFound('Person');
  return json({ ...person, roles: JSON.parse(person.roles_json), roles_json: undefined, addresses: addrs.results, tickets: tickets.results });
}

async function createPerson({ request, env, ctx }) {
  requirePerm(ctx, 'members', 'edit');
  const b = await readBody(request);
  const f = personFields(b);
  const db = env.DB;
  const id = newId();
  const cols = Object.keys(f);
  await db.batch([
    db.prepare(
      `INSERT INTO persons (id, company_id, member_no, old_code, ${cols.join(', ')})
       VALUES (?, ?, (SELECT COALESCE(MAX(member_no), 0) + 1 FROM persons WHERE company_id = ?), ?, ${cols.map(() => '?').join(', ')})`
    ).bind(id, ctx.companyId, ctx.companyId, str(b, 'old_code'), ...Object.values(f)),
    ...addressStatements(db, id, b.addresses),
    auditStatement(db, ctx, 'create', 'persons', id, `Person ${f.name} registered`, null, { ...f, addresses: b.addresses }),
  ]);
  const row = await db.prepare('SELECT member_no FROM persons WHERE id = ?').bind(id).first();
  return json({ id, member_no: row.member_no }, 201);
}

async function updatePerson({ request, env, ctx, params }) {
  requirePerm(ctx, 'members', 'edit');
  const db = env.DB;
  const old = await db.prepare('SELECT * FROM persons WHERE company_id = ? AND id = ?').bind(ctx.companyId, params.id).first();
  if (!old) throw notFound('Person');
  const b = await readBody(request);
  const f = personFields({ ...old, roles: JSON.parse(old.roles_json), ...b });
  await db.batch([
    db.prepare(`UPDATE persons SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(f), old.id),
    ...addressStatements(db, old.id, b.addresses),
    auditStatement(db, ctx, 'update', 'persons', old.id, `Person ${f.name} changed`, old, { ...f, addresses: b.addresses }),
  ]);
  return json({ ok: true });
}

// ---- groups ----

const FINANCIAL = ['chit_amount', 'installments', 'installment_amount', 'commission_bp', 'gst_bp', 'dividend_timing', 'prized_pays', 'round_dividend_down', 'no_auction_installments', 'start_date'];

function groupFields(b) {
  const f = {
    branch_id: str(b, 'branch_id'),
    name: str(b, 'name', { required: true, max: 40, label: 'group name' }),
    series: str(b, 'series', { max: 20 }),
    chit_amount: paise(b, 'chit_amount', { required: true, min: 100, label: 'chit amount' }),
    installments: int(b, 'installments', { required: true, min: 2, max: 600, label: 'number of installments' }),
    installment_amount: paise(b, 'installment_amount', { min: 1, label: 'installment amount' }),
    auction_type: oneOf(b, 'auction_type', ['Monthly', 'Fortnightly', 'Weekly', 'Daily'], { fallback: 'Monthly' }),
    start_date: date(b, 'start_date', { required: true, label: 'commencement date' }),
    termination_date: date(b, 'termination_date'),
    pso_no: str(b, 'pso_no'),
    pso_date: date(b, 'pso_date'),
    bylaw_no: str(b, 'bylaw_no'),
    bylaw_date: date(b, 'bylaw_date'),
    registered_at: str(b, 'registered_at'),
    enrolment_fee: paise(b, 'enrolment_fee') ?? 0,
    commission_bp: int(b, 'commission_bp', { required: true, max: 10000, label: 'commission %' }),
    max_bid_bp: int(b, 'max_bid_bp', { max: 10000 }) ?? 4000,
    gst_bp: int(b, 'gst_bp', { max: 10000 }) ?? 0,
    late_fee_nps_bp: int(b, 'late_fee_nps_bp', { max: 10000 }) ?? 0,
    late_fee_ps_bp: int(b, 'late_fee_ps_bp', { max: 10000 }) ?? 0,
    late_fee_basis: oneOf(b, 'late_fee_basis', ['month', 'year'], { fallback: 'month' }),
    dividend_timing: oneOf(b, 'dividend_timing', ['same', 'next'], { fallback: 'same' }),
    prized_pays: oneOf(b, 'prized_pays', ['reduced', 'full'], { fallback: 'reduced' }),
    round_dividend_down: bool(b, 'round_dividend_down', 1),
    no_auction_installments: int(b, 'no_auction_installments') ?? 0,
    auction_method: oneOf(b, 'auction_method', ['both', 'bidding', 'lottery', 'company'], { fallback: 'both' }),
    lottery_discount_bp: int(b, 'lottery_discount_bp', { max: 10000 }) ?? 0,
    auction_day: int(b, 'auction_day', { min: 1, max: 31 }),
    auction_time_from: str(b, 'auction_time_from', { max: 5 }),
    auction_time_to: str(b, 'auction_time_to', { max: 5 }),
    status: oneOf(b, 'status', ['Forming', 'Running', 'Closed'], { fallback: 'Running' }),
  };
  if (f.max_bid_bp < f.commission_bp) throw bad('The bid ceiling cannot be lower than the commission.');
  if (f.no_auction_installments >= f.installments) throw bad('No-auction installments must be fewer than the installments.');
  return f;
}

async function listGroups({ env, ctx }) {
  requirePerm(ctx, 'groups');
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.chit_amount, g.installments, g.installment_amount, g.commission_bp, g.start_date, g.status,
            (SELECT count(*) FROM enrollments e WHERE e.group_id = g.id AND e.status = 'Active') AS tickets_filled,
            (SELECT count(*) FROM auctions a WHERE a.group_id = g.id AND a.status = 'Active') AS auctions_held
       FROM chit_groups g WHERE g.company_id = ? ORDER BY g.name`
  ).bind(ctx.companyId).all();
  return json(results.map((g) => ({ ...g, installment: installmentOf(g), commission: commissionOf(g) })));
}

async function getGroup({ env, ctx, params }) {
  requirePerm(ctx, 'groups');
  const s = await loadGroupState(env.DB, ctx.companyId, params.id);
  const byTicket = new Map(s.enrollments.map((e) => [e.ticket_no, e]));
  const tickets = [];
  for (let t = 1; t <= s.g.installments; t++) {
    const e = byTicket.get(t);
    if (!e) { tickets.push({ ticket_no: t, status: 'Vacant' }); continue; }
    if (e.is_company) { tickets.push({ ticket_no: t, enrollment_id: e.id, status: 'Company' }); continue; }
    const L = ledgerFor(s, e);
    tickets.push({
      ticket_no: t, enrollment_id: e.id, person_id: e.person_id, name: e.person_name, mobile: e.mobile,
      status: L.prized ? 'PS' : 'NPS', won_auction_no: L.won_auction_no, balance: L.balance, arrears: L.arrears, penalty_due: L.penalty_due,
      collection_agent: e.collection_agent_name,
    });
  }
  return json({ ...s.g, installment: installmentOf(s.g), commission: commissionOf(s.g), auctions_held: s.auctions.length, tickets });
}

async function createGroup({ request, env, ctx }) {
  requirePerm(ctx, 'groups', 'edit');
  const f = groupFields(await readBody(request));
  const db = env.DB;
  const id = newId();
  const cols = Object.keys(f);
  await db.batch([
    db.prepare(`INSERT INTO chit_groups (id, company_id, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`).bind(id, ctx.companyId, ...Object.values(f)),
    auditStatement(db, ctx, 'create', 'chit_groups', id, `Group ${f.name} created`, null, f),
  ]);
  return json({ id }, 201);
}

async function updateGroup({ request, env, ctx, params }) {
  requirePerm(ctx, 'groups', 'edit');
  const db = env.DB;
  const old = await loadGroup(db, ctx.companyId, params.id);
  const b = await readBody(request);
  const f = groupFields({ ...old, ...b });
  const held = await db.prepare("SELECT count(*) AS n FROM auctions WHERE group_id = ? AND status = 'Active'").bind(old.id).first();
  if (held.n > 0) {
    const changed = FINANCIAL.filter((k) => f[k] !== old[k]);
    if (changed.length) throw conflict(`Auctions have been held, so these can no longer change: ${changed.join(', ')}.`);
  }
  await db.batch([
    db.prepare(`UPDATE chit_groups SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(f), old.id),
    auditStatement(db, ctx, 'update', 'chit_groups', old.id, `Group ${f.name} changed`, old, f),
  ]);
  return json({ ok: true });
}

// ---- enrollment ----

async function enroll({ request, env, ctx }) {
  requirePerm(ctx, 'enroll', 'edit');
  const b = await readBody(request);
  const db = env.DB;
  const g = await loadGroup(db, ctx.companyId, str(b, 'group_id', { required: true, label: 'group' }));
  const ticket = int(b, 'ticket_no', { required: true, min: 1, max: g.installments, label: 'ticket number' });
  const isCompany = bool(b, 'is_company');
  const personId = isCompany ? null : str(b, 'person_id', { required: true, label: 'member' });

  const ids = { person_id: personId, business_agent_id: str(b, 'business_agent_id'), collection_agent_id: str(b, 'collection_agent_id'), guarantor1_id: str(b, 'guarantor1_id'), guarantor2_id: str(b, 'guarantor2_id') };
  for (const [k, v] of Object.entries(ids)) {
    if (v && !(await db.prepare('SELECT 1 FROM persons WHERE company_id = ? AND id = ? AND active = 1').bind(ctx.companyId, v).first())) throw bad(`${k} is not a registered person.`);
  }
  const taken = await db.prepare("SELECT 1 FROM enrollments WHERE group_id = ? AND ticket_no = ? AND status = 'Active'").bind(g.id, ticket).first();
  if (taken) throw conflict(`Ticket ${ticket} of ${g.name} is already taken.`);

  const id = newId();
  const f = {
    ...ids,
    is_company: isCompany,
    enrolment_date: date(b, 'enrolment_date') || todayIst(),
    nominee_name: str(b, 'nominee_name'), nominee_relation: str(b, 'nominee_relation'), nominee_address: str(b, 'nominee_address', { max: 400 }),
    zone: str(b, 'zone'), area: str(b, 'area'), director: str(b, 'director'), payment_mode: str(b, 'payment_mode'), pass_book_no: str(b, 'pass_book_no'),
    agreement_done: bool(b, 'agreement_done'), intimation_card_done: bool(b, 'intimation_card_done'), introducer_incentive: paise(b, 'introducer_incentive'),
  };
  const cols = Object.keys(f);
  await db.batch([
    db.prepare(`INSERT INTO enrollments (id, company_id, group_id, ticket_no, ${cols.join(', ')}) VALUES (?, ?, ?, ?, ${cols.map(() => '?').join(', ')})`)
      .bind(id, ctx.companyId, g.id, ticket, ...Object.values(f)),
    auditStatement(db, ctx, 'create', 'enrollments', id, `Ticket ${ticket} of ${g.name} given to ${isCompany ? 'the company' : personId}`, null, f),
  ]);
  return json({ id, group_id: g.id, ticket_no: ticket }, 201);
}

// One ticket's account copy: dues by installment, receipts and penalty.
async function accountCopy({ env, ctx, params, query }) {
  const db = env.DB;
  const e = await db.prepare('SELECT * FROM enrollments WHERE company_id = ? AND id = ?').bind(ctx.companyId, params.id).first();
  if (!e) throw notFound('Ticket');
  const own = ownTicketsOnly(ctx) && e.collection_agent_id === ctx.user.person_id;
  if (!own && !can(ctx, 'reports') && !can(ctx, 'receipts')) throw forbidden();
  if (ownTicketsOnly(ctx) && !own) throw forbidden('This ticket is not assigned to you.');
  const s = await loadGroupState(db, ctx.companyId, e.group_id);
  const asOf = query.get('as_of') || todayIst();
  const L = ledgerFor(s, e, asOf);
  const person = e.person_id ? await db.prepare('SELECT id, member_no, name FROM persons WHERE id = ?').bind(e.person_id).first() : null;
  const receipts = s.receipts.filter((r) => r.enrollment_id === e.id).map((r) => ({
    id: r.id, receipt_no: r.receipt_no, receipt_date: r.receipt_date, mode: r.mode, amount: r.amount, penalty: r.penalty, enrolment_fee: r.enrolment_fee, insts: r.insts,
  }));
  return json({ group: { id: s.g.id, name: s.g.name }, ticket_no: e.ticket_no, person, as_of: asOf, ...L, receipts });
}

export const masterRoutes = [
  ['GET', '/api/persons', listPersons],
  ['POST', '/api/persons', createPerson],
  ['GET', '/api/persons/:id', getPerson],
  ['PATCH', '/api/persons/:id', updatePerson],
  ['GET', '/api/groups', listGroups],
  ['POST', '/api/groups', createGroup],
  ['GET', '/api/groups/:id', getGroup],
  ['PATCH', '/api/groups/:id', updateGroup],
  ['POST', '/api/enrollments', enroll],
  ['GET', '/api/enrollments/:id/account', accountCopy],
];
