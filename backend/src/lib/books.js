// Accounts and audit trail. Every write in the API adds its voucher and audit row
// to the same D1 batch, so they are saved together or not at all.

import { newId } from './http.js';

// Chart of accounts from the prototype (ADEF and AX in public/apps/office.html).
export const DEFAULT_ACCOUNTS = [
  ['1001', 'Cash in hand', 'Assets', 'Cash'],
  ['1002', 'Bank balances', 'Assets', 'Bank'],
  ['1003', 'Subscriptions receivable', 'Assets', 'Receivables'],
  ['1004', 'FDR and statutory deposits', 'Assets', 'Investments'],
  ['1005', 'Bid advances paid', 'Assets', 'Receivables'],
  ['1007', 'Petty cash', 'Assets', 'Cash'],
  ['1010', 'GST receivable', 'Assets', 'Duties and taxes'],
  ['2001', 'Chit subscriptions held', 'Liabilities', 'Chit funds'],
  ['2002', 'Bid payable', 'Liabilities', 'Chit funds'],
  ['2003', 'Refunds payable', 'Liabilities', 'Chit funds'],
  ['2004', 'Dividend payable to members', 'Liabilities', 'Chit funds'],
  ['2005', 'GST payable', 'Liabilities', 'Duties and taxes'],
  ['2006', 'Future receipts held', 'Liabilities', 'Chit funds'],
  ['2007', 'Capital and reserves', 'Liabilities', 'Capital'],
  ['2008', 'TDS payable', 'Liabilities', 'Duties and taxes'],
  ['3001', 'Foreman commission', 'Income', 'Chit income'],
  ['3002', 'Penalty and late fee', 'Income', 'Chit income'],
  ['3003', 'Enrolment fee', 'Income', 'Chit income'],
  ['3004', 'Cancellation charges', 'Income', 'Chit income'],
  ['3005', 'FDR interest', 'Income', 'Other income'],
  ['3006', 'Other charges recovered', 'Income', 'Chit income'],
  ['3007', 'Internet handling charges', 'Income', 'Chit income'],
  ['4001', 'Salaries', 'Expenses', 'Staff costs'],
  ['4002', 'Agent and marketing commission', 'Expenses', 'Staff costs'],
  ['4003', 'Rent', 'Expenses', 'Office costs'],
  ['4004', 'Office expenses', 'Expenses', 'Office costs'],
  ['4005', 'Printing and stationery', 'Expenses', 'Office costs'],
  ['4006', 'Bank charges', 'Expenses', 'Finance costs'],
];

export const AC = {
  cash: '1001', bank: '1002', bidAdvance: '1005', held: '2001', bidPayable: '2002', gstPayable: '2005',
  commission: '3001', penalty: '3002', enrolFee: '3003', other: '3006', handling: '3007',
};

// Ledger account ids are fixed per company, so postings never need a lookup.
export const acctId = (companyId, code) => `${companyId}:${code}`;

export const chartStatements = (db, companyId) =>
  DEFAULT_ACCOUNTS.map(([code, name, group, sub]) =>
    db.prepare(
      `INSERT OR IGNORE INTO ledger_accounts (id, company_id, code, name, account_group, sub_group, opening_side, is_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(acctId(companyId, code), companyId, code, name, group, sub, group === 'Assets' || group === 'Expenses' ? 'Dr' : 'Cr')
  );

// A balanced voucher. lines: [{ code, dr, cr, group_id, enrollment_id }]. Zero lines are dropped.
export function voucherStatements(db, ctx, { series, date, sourceTable, sourceId, narration, lines }) {
  const kept = lines.filter((l) => (l.dr || 0) > 0 || (l.cr || 0) > 0);
  const dr = kept.reduce((s, l) => s + (l.dr || 0), 0);
  const cr = kept.reduce((s, l) => s + (l.cr || 0), 0);
  if (dr !== cr) throw new Error(`Voucher does not balance: Dr ${dr} Cr ${cr}`);
  if (!kept.length) return [];
  const id = newId();
  return [
    db.prepare(
      `INSERT INTO vouchers (id, company_id, series, voucher_no, voucher_date, source_table, source_id, narration, created_by)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(voucher_no), 0) + 1 FROM vouchers WHERE company_id = ? AND series = ?), ?, ?, ?, ?, ?)`
    ).bind(id, ctx.companyId, series, ctx.companyId, series, date, sourceTable, sourceId, narration, ctx.user.id),
    ...kept.map((l, i) =>
      db.prepare(
        'INSERT INTO voucher_lines (voucher_id, line_no, ledger_account_id, debit, credit, group_id, enrollment_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, i + 1, acctId(ctx.companyId, l.code), l.dr || 0, l.cr || 0, l.group_id || null, l.enrollment_id || null)
    ),
  ];
}

export const cancelVoucherStatement = (db, ctx, sourceTable, sourceId) =>
  db.prepare('UPDATE vouchers SET cancelled = 1 WHERE company_id = ? AND source_table = ? AND source_id = ?').bind(ctx.companyId, sourceTable, sourceId);

export const auditStatement = (db, ctx, action, entity, entityId, summary, oldValue = null, newValue = null) =>
  db.prepare(
    'INSERT INTO audit_log (id, company_id, user_id, action, entity, entity_id, summary, old_json, new_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    newId(), ctx.companyId, ctx.user?.id || null, action, entity, entityId, summary,
    oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue)
  );
