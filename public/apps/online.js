/* Online mode for the office software.
 *
 * The office page keeps all its data in one object, S, and calls save() after every change.
 * In online mode this file:
 *   - signs in against the API instead of the browser's own staff list,
 *   - fills S from the server (GET /api/sync) instead of the browser's storage,
 *   - on every save(), works out what changed in S since the last load and sends those
 *     changes to the API, then reloads S from the server, which is always the master copy.
 * The browser's own data is never touched, so "This browser only" mode still has it.
 *
 * Money in S is in rupees; the API uses whole paise. Percentages in S are plain numbers;
 * the API uses basis points (1% = 100).
 */
(function () {
  'use strict';
  if (location.protocol === 'file:') return;

  const MODE_KEY = 'cm-mode', TOKEN_KEY = 'cm-token', CO_KEY = 'cm-company';
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
  };
  const setMode = (m) => { store.set(MODE_KEY, m); location.reload(); };
  window.cmSetMode = setMode;

  // ---- browser-only mode: leave everything as it is, plus a way back to online ----
  if (store.get(MODE_KEY) === 'local') {
    const tag = document.createElement('div');
    tag.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#fff;border:1px solid #ccc;border-radius:16px;padding:6px 12px;font:13px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12)';
    tag.innerHTML = 'This browser\'s own data · <a href="#" onclick="cmSetMode(\'online\');return false">Switch to online</a>';
    document.body.appendChild(tag);
    return;
  }

  // ---- conversions ----
  const n = (v) => +v || 0;
  const rup = (p) => (p == null ? '' : p / 100);
  const pai = (r) => Math.round(n(r) * 100);
  const pct = (bp) => (bp == null ? '' : bp / 100);
  const bp = (x) => Math.round(n(x) * 100);
  const nul = (v) => (v === '' || v == null ? null : v);
  const pick = (o, keys) => { const r = {}; for (const k in o) if (!keys.includes(k)) r[k] = o[k]; return r; };

  const METHOD = { both: 'both', bid: 'bidding', lottery: 'lottery', none: 'company' };
  const METHOD_BACK = { both: 'both', bidding: 'bid', lottery: 'lottery', company: 'none' };
  const KIND = { 'Open bid': 'bidding', 'Bid offer': 'bid offer', Proxy: 'proxy', Lottery: 'lottery', 'Company decided': 'company' };
  const KIND_BACK = { bidding: 'Open bid', 'bid offer': 'Bid offer', proxy: 'Proxy', lottery: 'Lottery', company: 'Company decided' };
  const ROLE = { member: 'Member', agent: 'Agent', guarantor: 'Guarantor', staff: 'Staff', marketer: 'Marketer' };
  const ROLE_BACK = { Member: 'member', Agent: 'agent', 'Collection agent': 'agent', 'Business agent': 'agent', Guarantor: 'guarantor', Staff: 'staff', Marketer: 'marketer' };
  const ADDR = { res: 'residential', off: 'office', cor: 'correspondence' };
  const ADDR_FIELDS = { door: 'door', street: 'street', addr: 'area', city: 'city', district: 'district', state: 'state', pin: 'pin', mobile: 'mobile', phone: 'mobile2', email: 'email' };

  // groups
  const G_KEYS = ['id', 'name', 'amount', 'n', 'instAmt', 'atype', 'start', 'term', 'pso', 'psoDate', 'bylaw', 'bylawDate', 'regAt', 'series', 'enrolFee', 'commPct', 'maxPct', 'gstPct', 'penNPS', 'penPS', 'divMode', 'psPays', 'roundDiv', 'noAuc', 'aMethod', 'lotPct', 'aDay', 'aTimeFrom', 'aTimeTo', 'closed'];
  const fromGroup = (g) => Object.assign({}, g.extra, {
    id: g.id, name: g.name, amount: rup(g.chit_amount), n: g.installments, instAmt: g.installment_amount ? rup(g.installment_amount) : '', atype: g.auction_type,
    start: g.start_date, term: g.termination_date || '', pso: g.pso_no || '', psoDate: g.pso_date || '', bylaw: g.bylaw_no || '', bylawDate: g.bylaw_date || '',
    regAt: g.registered_at || '', series: g.series || '', enrolFee: rup(g.enrolment_fee), commPct: pct(g.commission_bp), maxPct: pct(g.max_bid_bp), gstPct: pct(g.gst_bp),
    penNPS: pct(g.late_fee_nps_bp), penPS: pct(g.late_fee_ps_bp), divMode: g.dividend_timing, psPays: g.prized_pays, roundDiv: !!g.round_dividend_down,
    noAuc: String(g.no_auction_installments), aMethod: METHOD_BACK[g.auction_method] || 'both', lotPct: pct(g.lottery_discount_bp), aDay: g.auction_day || '',
    aTimeFrom: g.auction_time_from || '', aTimeTo: g.auction_time_to || '', closed: g.status === 'Closed',
  });
  const toGroup = (g) => ({
    id: g.id, name: g.name, chit_amount: pai(g.amount), installments: n(g.n), installment_amount: n(g.instAmt) > 0 ? pai(g.instAmt) : null, auction_type: g.atype || 'Monthly',
    start_date: g.start, termination_date: nul(g.term), pso_no: g.pso, pso_date: nul(g.psoDate), bylaw_no: g.bylaw, bylaw_date: nul(g.bylawDate), registered_at: g.regAt, series: g.series,
    enrolment_fee: pai(g.enrolFee), commission_bp: bp(g.commPct), max_bid_bp: bp(g.maxPct), gst_bp: bp(g.gstPct),
    // The office screens charge late fee per month at the company's rates (Settings), so new groups take those.
    late_fee_nps_bp: bp(g.penNPS !== '' && g.penNPS != null ? g.penNPS : S.penNPS == null ? 1.2 : S.penNPS),
    late_fee_ps_bp: bp(g.penPS !== '' && g.penPS != null ? g.penPS : S.penPS == null ? 1.5 : S.penPS), late_fee_basis: 'month',
    dividend_timing: g.divMode || 'same', prized_pays: g.psPays || 'reduced', round_dividend_down: !!g.roundDiv, no_auction_installments: n(g.noAuc),
    auction_method: METHOD[g.aMethod] || 'both', lottery_discount_bp: bp(g.lotPct), auction_day: n(g.aDay) || null, auction_time_from: nul(g.aTimeFrom), auction_time_to: nul(g.aTimeTo),
    status: g.closed ? 'Closed' : 'Running', extra: pick(g, G_KEYS),
  });

  // persons
  const P_KEYS = ['id', 'mno', 'oldCode', 'title', 'name', 'relType', 'relName', 'gender', 'dob', 'occupation', 'pan', 'aadhaar4', 'gstNo', 'bankName', 'bankAcc', 'ifsc', 'entryDate', 'roles',
    ...Object.keys(ADDR).flatMap((p) => Object.keys(ADDR_FIELDS).map((f) => p + '_' + f))];
  const fromPerson = (p) => {
    const o = Object.assign({}, p.extra, {
      id: p.id, mno: p.member_no, oldCode: p.old_code || '', title: p.title || '', name: p.name, relType: p.relation_type || '', relName: p.relation_name || '', gender: p.gender || '',
      dob: p.dob || '', occupation: p.occupation || '', pan: p.pan || '', aadhaar4: p.aadhaar_last4 || '', gstNo: p.gst_no || '', bankName: p.bank_name || '', bankAcc: p.bank_account_no || '',
      ifsc: p.ifsc || '', entryDate: p.entry_date || '', roles: [...new Set((p.roles || []).map((r) => ROLE_BACK[r]).filter(Boolean))],
    });
    for (const a of p.addresses || []) {
      const pre = Object.keys(ADDR).find((k) => ADDR[k] === a.kind);
      for (const [f, col] of Object.entries(ADDR_FIELDS)) o[pre + '_' + f] = a[col] || '';
    }
    return o;
  };
  const toPerson = (p) => {
    const addresses = {};
    for (const [pre, kind] of Object.entries(ADDR)) {
      const a = {};
      let any = false;
      for (const [f, col] of Object.entries(ADDR_FIELDS)) { const v = p[pre + '_' + f]; if (v) { a[col] = String(v); any = true; } }
      if (any) addresses[kind] = a;
    }
    const roles = (p.roles || []).map((r) => ROLE[r]).filter(Boolean);
    return {
      id: p.id, old_code: p.oldCode, title: p.title, name: p.name, relation_type: p.relType, relation_name: p.relName, gender: p.gender, dob: nul(p.dob), occupation: p.occupation,
      pan: p.pan, aadhaar_last4: p.aadhaar4, gst_no: p.gstNo, bank_name: p.bankName, bank_account_no: p.bankAcc, ifsc: p.ifsc, entry_date: nul(p.entryDate),
      roles: roles.length ? roles : ['Member'], addresses, extra: pick(p, P_KEYS),
    };
  };

  // tickets
  const E_KEYS = ['id', 'gid', 'ticket', 'pid', 'date', 'bagent', 'cagent', 'g1', 'g2', 'nomName', 'nomRel', 'zone', 'area', 'director', 'payMode', 'agreement', 'introInc'];
  const fromEnroll = (e) => Object.assign({}, e.extra, {
    id: e.id, gid: e.group_id, ticket: e.ticket_no, pid: e.is_company ? 'CO' : e.person_id, date: e.enrolment_date || '', bagent: e.business_agent_id || '', cagent: e.collection_agent_id || '',
    g1: e.guarantor1_id || '', g2: e.guarantor2_id || '', nomName: e.nominee_name || '', nomRel: e.nominee_relation || '', zone: e.zone || '', area: e.area || '', director: e.director || '',
    payMode: e.payment_mode || '', agreement: !!e.agreement_done, introInc: e.introducer_incentive ? rup(e.introducer_incentive) : '',
  });
  const toEnroll = (e) => ({
    id: e.id, group_id: e.gid, ticket_no: n(e.ticket), is_company: e.pid === 'CO', person_id: e.pid === 'CO' ? null : e.pid, enrolment_date: nul(e.date),
    business_agent_id: nul(e.bagent), collection_agent_id: nul(e.cagent), guarantor1_id: nul(e.g1), guarantor2_id: nul(e.g2), nominee_name: e.nomName, nominee_relation: e.nomRel,
    zone: e.zone, area: e.area, director: e.director, payment_mode: e.payMode, agreement_done: !!e.agreement, introducer_incentive: n(e.introInc) > 0 ? pai(e.introInc) : null, extra: pick(e, E_KEYS),
  });

  // auctions (the server works out every figure, so only what was decided is sent)
  const A_KEYS = ['id', 'gid', 'no', 'date', 'dueDate', 'nextDate', 'ticket', 'kind', 'bid', 'gstPct', 'comm', 'gst', 'prize', 'netPrize', 'pool', 'div', 'net', 'minutes', 'coWin'];
  const fromAuction = (a) => Object.assign({}, a.extra, {
    id: a.id, gid: a.group_id, no: a.auction_no, date: a.auction_date, dueDate: a.due_date || a.auction_date, nextDate: a.next_auction_date || '', ticket: a.winner_ticket_no,
    kind: KIND_BACK[a.decided_by] || a.decided_by, bid: rup(a.bid), gstPct: pct(a.gst_bp), comm: rup(a.commission), gst: rup(a.gst), prize: rup(a.bid_payable), netPrize: rup(a.net_prize),
    pool: rup(a.dividend_pool), div: rup(a.dividend_per_ticket), net: rup(a.net_payable_per_ticket), minutes: a.minutes_filed_on || '', coWin: !!a.company_won,
  });
  const toAuction = (a) => ({
    id: a.id, group_id: a.gid, auction_date: a.date, due_date: nul(a.dueDate), next_auction_date: nul(a.nextDate), winner_ticket_no: n(a.ticket), decided_by: KIND[a.kind] || 'bidding',
    bid: a.kind === 'Company decided' ? null : pai(a.bid), gst_bp: bp(a.gstPct), minutes_filed_on: /^\d{4}-\d{2}-\d{2}$/.test(a.minutes || '') ? a.minutes : null, extra: pick(a, A_KEYS),
  });

  // receipts: in S the amount is the total received; the API keeps the subscription part on its own
  const R_KEYS = ['id', 'no', 'date', 'mode', 'gid', 'ticket', 'pid', 'tr', 'trDate', 'agent', 'amount', 'penalty', 'enrolFee', 'bankCharge', 'otherCharge', 'incCharge', 'reason', 'chq', 'cancel', 'insts'];
  const fromReceipt = (r) => {
    const x = r.extra || {};
    const inc = n(x.incCharge);
    return Object.assign({}, pick(x, ['chqExtra']), {
      id: r.id, no: r.receipt_no, date: r.receipt_date, mode: r.mode, gid: r.group_id, ticket: r.ticket_no, pid: r.person_id || 'CO', tr: r.tr_book_no || '', trDate: r.tr_date || '',
      agent: r.collection_agent_id || '', amount: rup(r.amount + r.penalty + r.enrolment_fee + r.bank_charge + r.other_charge + r.handling_charge), penalty: rup(r.penalty),
      enrolFee: rup(r.enrolment_fee), bankCharge: rup(r.bank_charge), otherCharge: rup(r.other_charge) - inc, incCharge: inc, reason: r.reason || '',
      chq: Object.assign({}, x.chqExtra, { no: r.cheque_no || '', bank: r.cheque_bank || '', date: r.cheque_date || '', place: r.cheque_place || '' }),
      cancel: !!r.cancelled, insts: r.insts || [], by: USERS[r.created_by] || '',
    });
  };
  const toReceipt = (r) => {
    const charges = n(r.penalty) + n(r.enrolFee) + n(r.bankCharge) + n(r.otherCharge) + n(r.incCharge);
    const chq = r.chq || {};
    return {
      id: r.id, group_id: r.gid, ticket_no: n(r.ticket), receipt_date: r.date, mode: r.mode, amount: pai(n(r.amount) - charges), penalty: pai(r.penalty), enrolment_fee: pai(r.enrolFee),
      bank_charge: pai(r.bankCharge), other_charge: pai(n(r.otherCharge) + n(r.incCharge)), insts: (r.insts || []).map(Number), tr_book_no: r.tr, tr_date: nul(r.trDate),
      collection_agent_id: nul(r.agent), cheque_no: chq.no, cheque_bank: chq.bank, cheque_date: nul(chq.date), cheque_place: chq.place, reason: r.reason,
      extra: Object.assign(pick(r, R_KEYS.concat(['by'])), { incCharge: n(r.incCharge), chqExtra: pick(chq, ['no', 'bank', 'date', 'place']) }),
    };
  };
  const receiptExtra = (r) => toReceipt(r).extra;

  // prize payments
  const X_KEYS = ['id', 'aid', 'date', 'mode', 'amount', 'adjBP', 'adjAdv', 'advUse', 'ref', 'chqDate', 'paidTo', 'narration', 'series', 'vno', 'dis'];
  const fromPay = (x) => Object.assign({}, x.extra, {
    id: x.id, aid: x.auction_id, date: x.payment_date, mode: x.mode, amount: rup(x.amount), adjBP: rup(x.adjusted_to_dues), adjAdv: rup(x.adjusted_advance), advUse: [],
    ref: x.reference || '', chqDate: x.cheque_date || '', paidTo: x.paid_to || '', narration: x.narration || '', series: x.voucher_series, vno: x.voucher_no, dis: !!x.cancelled,
  });
  const toPay = (x) => ({
    id: x.id, auction_id: x.aid, payment_date: x.date, mode: x.mode, amount: pai(x.amount), adjusted_to_dues: pai(x.adjBP), reference: x.ref, cheque_date: nul(x.chqDate),
    paid_to: x.paidTo, narration: x.narration, extra: pick(x, X_KEYS),
  });

  // ---- which parts of S go where ----
  const CORE = ['groups', 'persons', 'enrolls', 'auctions', 'receipts', 'payouts'];
  // Company settings and day-to-day lists, kept as shared settings on the server.
  const SHARED = ['company', 'coLogo', 'coAddr', 'coHead', 'coGstin', 'coPhone', 'coMobile', 'coWeb', 'coState', 'coEmail', 'coSac', 'masters', 'mPrefix', 'defCo', 'penPS', 'penNPS',
    'lockDate', 'upi', 'upiName', 'smsTpl', 'bpSeries', 'bvSeries', 'invPrefix', 'tdsPct', 'useLot', 'useBid', 'secSet', 'ntTpl', 'ntTplK', 'callMonths', 'acNet', 'targets',
    'bankAccts', 'cgNotes', 'ocV', 'accts', 'calls', 'enq', 'notices', 'smsLog', 'hist'];
  // Money records the online version cannot keep yet. Changing them is refused, so nothing is half-saved.
  const NOT_YET = { future: 'Future receipts', cancels: 'Member removal', bidAdv: 'Bid advances', pdcs: 'Post-dated cheques', transfers: 'Ticket transfers', reauctions: 'Reauction',
    denoms: 'Denomination entry', vouchers: 'Vouchers', loans: 'Loans on chits', fds: 'FD register', agentComm: 'Agent commission', agPays: 'Agent payments',
    closings: 'Year closing', advPosted: 'Advance subscription', docs: 'KYC documents' };
  const NOT_YET_PAGES = {
    future: 'Future receipts', denom: 'Denomination entry', reauc: 'Reauction', transfer: 'Ticket transfer', rmpay: 'Removal payments', subref: 'Subscriber refund', bidadv: 'Bid advances',
    pdc: 'Post-dated cheques', cancel: 'Member removal', loans: 'Loans on chits', fdreg: 'FD register', advsub: 'Advance subscription', vouch: 'Vouchers', cashrc: 'Cash receipts',
    cashpay: 'Cash payments', petty: 'Petty cash', bankdep: 'Bank deposits', bankpay: 'Bank payments', banktr: 'Bank transfers', agpay: 'Agent payments', agcomm: 'Agent commission',
    import: 'Import data', backup: 'Backup and restore', clearrc: 'Clear receipts', clearauc: 'Clear auctions', readj: 'Readjust receipts', yearclose: 'Year closing',
    kyc: 'KYC documents', dupm: 'Merge duplicate members', super: 'Software provider', chqupd: 'Cheque update', bstmt: 'Bank statement matching',
  };

  // ---- talking to the API ----
  let token = store.get(TOKEN_KEY);
  let USERS = {};
  let BASE = null; // what S looked like at the last load, by collection and id
  let busy = false;
  let COID = ''; // this company's id, for the member app link

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty reply */ }
    if (res.status === 401 && path !== '/auth/login') { signedOut(data.error || 'Please sign in again.'); throw new Error(data.error || 'Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || 'The server could not do this (' + res.status + ').');
    return data;
  }

  const snapshot = () => {
    const b = {};
    for (const k of CORE) b[k] = new Map((S[k] || []).map((x) => [x.id, JSON.stringify(x)]));
    b.shared = new Map(SHARED.map((k) => [k, JSON.stringify(S[k])]));
    b.notYet = new Map(Object.keys(NOT_YET).map((k) => [k, JSON.stringify(S[k] || [])]));
    return b;
  };

  function permsFor(api) {
    const has = (k) => !!(api.all || api[k]);
    const keys = ['dash', 'groups', 'members', 'enroll', 'accounts', 'agcomm', 'masters', 'import', 'auctions', 'payable', 'cancel', 'receipts', 'reports', 'settings', 'staff', 'del', 'cancelRc'];
    const p = {};
    for (const k of keys) p[k] = has(k);
    p.masters = has('settings') || (api.groups === 'edit');
    return p;
  }

  async function loadAll() {
    BASE = null; // so a save() made while loading is not sent
    const d = await api('GET', '/sync');
    USERS = Object.fromEntries(d.users.map((u) => [u.id, u.name]));
    COID = d.company.id;
    const set = d.company.settings || {};
    const fresh = norm(Object.assign({}, set, {
      company: set.company || d.company.name,
      mPrefix: set.mPrefix != null ? set.mPrefix : d.company.member_prefix,
      groups: d.groups.map(fromGroup),
      persons: d.persons.map(fromPerson),
      enrolls: d.enrollments.map(fromEnroll),
      auctions: d.auctions.map(fromAuction),
      receipts: d.receipts.map(fromReceipt),
      payouts: d.prize_payments.map(fromPay),
    }));
    fresh.seq = { r: Math.max(0, ...fresh.receipts.map((r) => r.no)), m: Math.max(0, ...fresh.persons.map((p) => p.mno || 0)), b: Math.max(0, ...fresh.payouts.map((x) => x.vno || 0)) };
    fresh.roles = [{ id: 'r_online', name: d.me.role.name, sys: !!d.me.perms.all, perms: permsFor(d.me.perms) }];
    ST.user = { id: d.me.user.id, name: d.me.user.name, user: d.me.user.username, roleId: 'r_online', active: true };
    fresh.staff = [ST.user];
    fresh.lock = {};
    // Member app logins live on the server; their buttons call it directly (see below), so they are not part of save().
    fresh.appLogins = {};
    if (d.me.perms.all || d.me.perms.members) {
      for (const l of await api('GET', '/member-logins')) {
        fresh.appLogins[l.person_id] = { must: !!l.must_change, active: !!l.active, locked: !!l.locked, issued: (l.issued_at || '').slice(0, 10), by: l.issued_by || '', last: l.last_sign_in || '' };
      }
    }
    S = fresh;
    // The same account list the browser version builds when it starts.
    if (S.accts.length) AX.forEach((a) => { if (!S.accts.some((x) => x.id === a.id)) S.accts.push(Object.assign({}, a)); });
    ocApply();
    BASE = snapshot();
  }

  // ---- working out and sending what changed ----
  function changes() {
    const out = { add: {}, change: {}, remove: {}, shared: {}, notYet: [] };
    for (const k of CORE) {
      const base = BASE[k], now = new Map((S[k] || []).map((x) => [x.id, x]));
      out.add[k] = [...now.values()].filter((x) => !base.has(x.id));
      out.change[k] = [...now.values()].filter((x) => base.has(x.id) && base.get(x.id) !== JSON.stringify(x));
      out.remove[k] = [...base.keys()].filter((id) => !now.has(id)).map((id) => JSON.parse(base.get(id)));
    }
    for (const k of SHARED) if (BASE.shared.get(k) !== JSON.stringify(S[k])) out.shared[k] = S[k];
    for (const k of Object.keys(NOT_YET)) if (BASE.notYet.get(k) !== JSON.stringify(S[k] || [])) out.notYet.push(NOT_YET[k]);
    return out;
  }

  const before = (k, id) => JSON.parse(BASE[k].get(id));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function push(c) {
    // Order matters: people and groups before tickets, tickets before auctions and receipts.
    for (const p of c.add.persons) await api('POST', '/persons', toPerson(p));
    for (const p of c.change.persons) await api('PATCH', '/persons/' + p.id, toPerson(p));
    for (const g of c.add.groups) await api('POST', '/groups', toGroup(g));
    for (const g of c.change.groups) await api('PATCH', '/groups/' + g.id, toGroup(g));
    for (const e of c.add.enrolls) await api('POST', '/enrollments', toEnroll(e));
    for (const e of c.change.enrolls) { const b = toEnroll(e); delete b.group_id; delete b.ticket_no; delete b.is_company; await api('PATCH', '/enrollments/' + e.id, b); }
    for (const a of c.add.auctions) await api('POST', '/auctions', toAuction(a));
    for (const a of c.change.auctions) {
      const was = toAuction(before('auctions', a.id)), now = toAuction(a);
      if (!same(pick(was, ['extra']), pick(now, ['extra']))) throw new Error('An auction cannot be changed after it is recorded. Undo is not available online yet.');
      await api('PATCH', '/auctions/' + a.id, { extra: now.extra });
    }
    for (const r of c.add.receipts) {
      if (typeof isAdjMode === 'function' && isAdjMode(r.mode)) throw new Error('Adjustment receipts (' + r.mode + ') are not available online yet.');
      await api('POST', '/receipts', toReceipt(r));
    }
    for (const r of c.change.receipts) {
      const was = before('receipts', r.id);
      if (r.cancel && !was.cancel) { await api('POST', '/receipts/' + r.id + '/cancel', { reason: r.cancelReason || 'Cancelled in the office software' }); continue; }
      const a = toReceipt(was), b = toReceipt(r);
      if (!same(pick(a, ['extra']), pick(b, ['extra']))) throw new Error('A saved receipt cannot be changed. Cancel it and enter it again.');
      await api('PATCH', '/receipts/' + r.id, { extra: receiptExtra(r) });
    }
    for (const x of c.add.payouts) {
      if (n(x.adjAdv) > 0) throw new Error('Using a bid advance in a prize payment is not available online yet.');
      await api('POST', '/prize-payments', toPay(x));
    }
    for (const x of c.change.payouts) {
      const was = toPay(before('payouts', x.id)), now = toPay(x);
      if (!same(pick(was, ['extra']), pick(now, ['extra']))) throw new Error('A saved prize payment cannot be changed. Delete it and enter it again.');
      await api('PATCH', '/prize-payments/' + x.id, { extra: now.extra });
    }
    // Removals. Money records are cancelled, never erased.
    for (const x of c.remove.payouts) if (!x.dis) await api('POST', '/prize-payments/' + x.id + '/cancel', { reason: 'Deleted in the office software' });
    for (const r of c.remove.receipts) if (!r.cancel) await api('POST', '/receipts/' + r.id + '/cancel', { reason: 'Deleted in the office software' });
    if (c.remove.auctions.length) throw new Error('Undoing an auction is not available online yet.');
    for (const e of c.remove.enrolls) await api('DELETE', '/enrollments/' + e.id);
    for (const g of c.remove.groups) await api('DELETE', '/groups/' + g.id);
    for (const p of c.remove.persons) await api('DELETE', '/persons/' + p.id);
  }

  function showBusy(on) {
    let el = document.getElementById('cm-busy');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cm-busy';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,.45);display:flex;align-items:flex-start;justify-content:center;padding-top:18px;cursor:progress';
      el.innerHTML = '<span style="background:#12766b;color:#fff;padding:8px 16px;border-radius:20px;font:600 14px sans-serif">Saving to the server…</span>';
      document.body.appendChild(el);
    }
    el.hidden = !on;
  }

  async function onlineSave() {
    if (!BASE || !ST.user || busy) return;
    const c = changes();
    const any = c.notYet.length || Object.keys(c.shared).length || CORE.some((k) => c.add[k].length || c.change[k].length || c.remove[k].length);
    if (!any) return;
    busy = true;
    showBusy(true);
    let error = null;
    try {
      if (c.notYet.length) throw new Error(c.notYet.join(', ') + ' cannot be saved in the online version yet. Nothing was saved.');
      await push(c);
      if (Object.keys(c.shared).length) {
        try { await api('PATCH', '/settings', { values: c.shared }); }
        catch (e) { error = 'The entry was saved, but the settings change was not: ' + e.message; }
      }
    } catch (e) {
      error = e.message + (e.message.includes('Nothing was saved') ? '' : ' Your screen has been refreshed from the server.');
    }
    try { await loadAll(); } catch (e) { error = error || e.message; }
    busy = false;
    showBusy(false);
    if (error) { flash = { t: error, k: 'bad' }; ask_ = null; }
    render();
  }

  // ---- member app logins: each button is one request, then the screen reloads from the server ----
  async function appCall(fn) {
    if (busy) return { error: 'Please wait, the last change is still being saved.' };
    busy = true;
    showBusy(true);
    let out, error = null;
    try { out = await fn(); } catch (e) { error = e.message; }
    try { await loadAll(); } catch (e) { error = error || e.message; }
    busy = false;
    showBusy(false);
    if (error) flash = { t: error, k: 'bad' };
    return { out, error };
  }
  window.apIssue = async (pid) => {
    const { out, error } = await appCall(() => api('POST', '/member-logins', { person_id: pid }));
    if (!error) F.apNew = { pid, pw: out.password, list: null };
    render();
  };
  // The member app link carries the company, so members never type a company code.
  const appLink = () => location.origin + '/apps/member.html?co=' + encodeURIComponent(COID);
  const localApMsg = window.apMsg, localApList = window.apListText;
  window.apMsg = (pid, pw) => { const l = localApMsg(pid, pw).split('\n'); l.splice(2, 0, 'Open the app: ' + appLink()); return l.join('\n'); };
  window.apListText = (l) => 'Member app: ' + appLink() + '\n' + localApList(l);
  window.apReset = (pid) => askConfirm('Make a new temporary password for ' + pnn(pid) + '? The old password stops working and the member is signed out of the app.', () => window.apIssue(pid));
  window.apToggle = async (pid) => {
    const l = appL()[pid];
    if (!l) return;
    const { error } = await appCall(() => api('PATCH', '/member-logins/' + pid, l.locked && l.active ? { unlock: true } : { active: !l.active }));
    if (error) return render();
    note(l.locked && l.active ? 'Login unlocked.' : l.active ? 'Login switched off. The member cannot sign in to the app.' : 'Login switched on.');
  };
  window.apRemove = (pid) => askConfirm('Remove the app login of ' + pnn(pid) + '? You can issue a new one later.', async () => {
    const { error } = await appCall(() => api('DELETE', '/member-logins/' + pid));
    F.apNew = null;
    if (error) return render();
    note('Login removed.');
  });
  window.apBulk = () => {
    const todo = apPids().filter((id) => !appL()[id]);
    if (!todo.length) return note('Every member already has a login.');
    askConfirm('Issue logins to ' + todo.length + ' member' + (todo.length > 1 ? 's' : '') + '? The temporary passwords are shown once, on the next screen.', async () => {
      const list = [];
      // The server issues a batch at a time. Passwords already issued stay in the list even if a later batch fails.
      await appCall(async () => {
        let r;
        do {
          r = await api('POST', '/member-logins/bulk');
          for (const x of r.issued) list.push({ pid: x.person_id, user: x.username, pw: x.password });
        } while (r.remaining > 0 && r.issued.length);
      });
      F.apNew = { pid: '', pw: '', list };
      render();
    });
  };

  // ---- sign in and out ----
  function signedOut(msg) {
    token = '';
    store.set(TOKEN_KEY, '');
    ST.user = null;
    BASE = null;
    S = norm({});
    S.staff = [{ id: '_', active: true, user: '', name: '' }];
    ui = { page: 'dash', sub: null, id: null };
    if (msg) flash = { t: msg, k: 'bad' };
    render();
  }

  function onlineLoginPage() {
    const lastCo = store.get(CO_KEY);
    return '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:linear-gradient(160deg,#12766b,#073a35)">'
      + '<div class="card" style="width:100%;max-width:400px;padding:24px"><div style="font:800 1.5rem/1 sans-serif;color:#12766b;margin-bottom:6px">CHIT MASTER PRO</div>'
      + '<h1 style="margin:10px 0 4px">Sign in</h1><p class="sub">Online: your company\'s shared data, the same on every computer.</p><div id="err" class="err" hidden></div>'
      + '<label class="f">Username<input id="ol_u" autocomplete="username" autofocus onkeydown="if(event.key===\'Enter\')$(\'ol_p\').focus()"></label>'
      + '<label class="f">Password<input id="ol_p" type="password" autocomplete="current-password" onkeydown="if(event.key===\'Enter\')doLogin()"></label>'
      + '<label class="f">Company code <small>(only if your office has more than one company)</small><input id="ol_c" value="' + esc(lastCo) + '" autocomplete="off"></label>'
      + '<div class="row" style="margin-top:12px"><button class="btn" id="ol_go" onclick="doLogin()" style="width:100%;justify-content:center">Sign in</button></div>'
      + '<p class="muted" style="margin:14px 0 0">Forgot your password? Ask your owner to reset it.</p>'
      + '<p class="muted" style="margin:8px 0 0"><a href="#" onclick="cmSetMode(\'local\');return false">Use this browser\'s own data instead</a> (the earlier prototype, not shared)</p>'
      + '</div></div>';
  }

  async function onlineLogin() {
    const u = $('ol_u').value.trim(), p = $('ol_p').value, co = $('ol_c').value.trim();
    if (!u || !p) return err('Enter your username and password.');
    $('ol_go').disabled = true;
    try {
      const r = await api('POST', '/auth/login', Object.assign({ username: u, password: p }, co ? { company_id: co } : {}));
      token = r.token;
      store.set(TOKEN_KEY, token);
      store.set(CO_KEY, co);
      await loadAll();
      flash = null;
      go(firstPage());
    } catch (e) {
      if ($('ol_go')) $('ol_go').disabled = false;
      err(e.message);
    }
  }

  async function onlineLogout() {
    try { await api('POST', '/auth/logout'); } catch (e) { /* already signed out */ }
    signedOut();
  }

  // ---- switch the page over to online mode ----
  window.save = onlineSave;
  window.loginPage = onlineLoginPage;
  window.doLogin = onlineLogin;
  window.logout = onlineLogout;
  const localGo = window.go;
  window.go = function (page) {
    if (NOT_YET_PAGES[page]) return note(NOT_YET_PAGES[page] + ' is not available in the online version yet. It will be added in a later step.', 'bad');
    if (page === 'staff') return note('Staff logins are managed on the server. Ask the owner to add or change a login.', 'bad');
    return localGo.apply(this, arguments);
  };

  S = norm({});
  S.staff = [{ id: '_', active: true, user: '', name: '' }];
  ST.user = null;
  if (token) {
    loadAll().then(render, (e) => signedOut(e.message === 'Please sign in again.' ? '' : e.message));
  } else {
    render();
  }
})();
