-- Chit Master Pro: initial schema
-- Written for Cloudflare D1 (SQLite) and kept portable to PostgreSQL.
--
-- Conventions
--   * Every business table has company_id, so one database can hold several companies.
--   * Money is INTEGER paise (Rs 1 = 100). Never floating point.
--   * Percentages are INTEGER basis points (1% = 100, 18% = 1800, 2.5% = 250).
--   * Dates are TEXT 'YYYY-MM-DD'; timestamps are TEXT ISO 8601 in UTC.
--   * IDs are TEXT (UUIDs made by the server).
--   * Booleans are INTEGER 0/1.
--   * Receipts, auctions and payments are cancelled, never deleted.

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------
-- Companies, branches, staff, roles
------------------------------------------------------------------------

CREATE TABLE companies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_name      TEXT,
  phone           TEXT,
  email           TEXT,
  city            TEXT,
  state           TEXT,
  plan            TEXT NOT NULL DEFAULT 'Standard',
  valid_till      TEXT,
  status          TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Suspended', 'Closed')),
  member_prefix   TEXT NOT NULL DEFAULT 'M',
  online_handling_bp INTEGER NOT NULL DEFAULT 200,   -- 2% internet handling charge
  settings_json   TEXT NOT NULL DEFAULT '{}',        -- switches such as lottery on/off, online bidding on/off
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE branches (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  name        TEXT NOT NULL,
  address     TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, name)
);

CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  name        TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0,           -- Admin cannot be edited or removed
  perms_json  TEXT NOT NULL DEFAULT '{}',           -- {"receipts":true,"auctions":false,...}
  UNIQUE (company_id, name)
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  role_id         TEXT NOT NULL REFERENCES roles(id),
  branch_id       TEXT REFERENCES branches(id),     -- null = all branches
  person_id       TEXT,                             -- set when the user is also a collection agent
  name            TEXT NOT NULL,
  username        TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                    -- salted hash only, never the password
  mobile          TEXT,
  email           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, username)
);

CREATE TABLE sign_ins (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  username    TEXT NOT NULL,
  user_id     TEXT REFERENCES users(id),
  ok          INTEGER NOT NULL,
  detail      TEXT,                                 -- e.g. 'wrong password', 'locked'
  ip          TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Dropdown lists the company edits itself: occupation, bank, zone, area, director, payment mode.
CREATE TABLE lookup_values (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  list        TEXT NOT NULL,
  value       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, list, value)
);

-- Running numbers: receipt no, voucher no, member no, transfer no, PDC no.
CREATE TABLE counters (
  company_id  TEXT NOT NULL REFERENCES companies(id),
  name        TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, name)
);

------------------------------------------------------------------------
-- People: members, agents, guarantors (one table, roles say which)
------------------------------------------------------------------------

CREATE TABLE persons (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  branch_id       TEXT REFERENCES branches(id),
  member_no       INTEGER NOT NULL,                 -- shown as prefix + 5 digits, e.g. M00042
  old_code        TEXT,                             -- code in the old software, for the import
  title           TEXT,
  name            TEXT NOT NULL,
  relation_type   TEXT,                             -- S/o, D/o, W/o, C/o
  relation_name   TEXT,
  gender          TEXT,
  dob             TEXT,
  occupation      TEXT,
  employer        TEXT,
  designation     TEXT,
  monthly_income  INTEGER,                          -- paise
  pan             TEXT,
  aadhaar_last4   TEXT CHECK (aadhaar_last4 IS NULL OR length(aadhaar_last4) = 4),
  gst_no          TEXT,
  bank_name       TEXT,
  bank_account_no TEXT,
  ifsc            TEXT,
  photo_key       TEXT,                             -- private file storage key, never a public link
  signature_key   TEXT,
  roles_json      TEXT NOT NULL DEFAULT '["Member"]', -- Member, Collection agent, Business agent, Guarantor
  entry_date      TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, member_no)
);
CREATE INDEX persons_name ON persons (company_id, name);
CREATE INDEX persons_old_code ON persons (company_id, old_code);

-- Residential, office and correspondence addresses.
CREATE TABLE person_addresses (
  person_id   TEXT NOT NULL REFERENCES persons(id),
  kind        TEXT NOT NULL CHECK (kind IN ('residential', 'office', 'correspondence')),
  door        TEXT,
  street      TEXT,
  area        TEXT,
  city        TEXT,
  district    TEXT,
  state       TEXT,
  pin         TEXT,
  mobile      TEXT,
  mobile2     TEXT,
  email       TEXT,
  PRIMARY KEY (person_id, kind)
);
CREATE INDEX person_addresses_mobile ON person_addresses (mobile);

-- Customer app logins issued by the company.
CREATE TABLE member_logins (
  person_id     TEXT PRIMARY KEY REFERENCES persons(id),
  company_id    TEXT NOT NULL REFERENCES companies(id),
  mobile        TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  issued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, mobile)
);

------------------------------------------------------------------------
-- Chit groups and their rules
------------------------------------------------------------------------

CREATE TABLE chit_groups (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id),
  branch_id             TEXT REFERENCES branches(id),
  name                  TEXT NOT NULL,
  series                TEXT,
  chit_amount           INTEGER NOT NULL CHECK (chit_amount > 0),         -- paise
  installments          INTEGER NOT NULL CHECK (installments > 0),        -- = number of tickets
  installment_amount    INTEGER,                                          -- paise; null = chit_amount / installments
  auction_type          TEXT NOT NULL DEFAULT 'Monthly' CHECK (auction_type IN ('Monthly', 'Fortnightly', 'Weekly', 'Daily')),
  start_date            TEXT NOT NULL,
  termination_date      TEXT,
  pso_no                TEXT,
  pso_date              TEXT,
  bylaw_no              TEXT,
  bylaw_date            TEXT,
  registered_at         TEXT,                                             -- registration place
  enrolment_fee         INTEGER NOT NULL DEFAULT 0,                       -- paise
  -- rules
  commission_bp         INTEGER NOT NULL,                                 -- foreman commission
  max_bid_bp            INTEGER NOT NULL DEFAULT 4000,                    -- bid ceiling
  gst_bp                INTEGER NOT NULL DEFAULT 0,                       -- GST on commission
  late_fee_nps_bp       INTEGER NOT NULL DEFAULT 0,                       -- per annum, non-prized
  late_fee_ps_bp        INTEGER NOT NULL DEFAULT 0,                       -- per annum, prized
  dividend_timing       TEXT NOT NULL DEFAULT 'same' CHECK (dividend_timing IN ('same', 'next')),
  prized_pays           TEXT NOT NULL DEFAULT 'reduced' CHECK (prized_pays IN ('reduced', 'full')),
  round_dividend_down   INTEGER NOT NULL DEFAULT 1,
  no_auction_installments INTEGER NOT NULL DEFAULT 0,                     -- first months with no auction
  -- auction setup
  auction_method        TEXT NOT NULL DEFAULT 'both' CHECK (auction_method IN ('both', 'bidding', 'lottery', 'company')),
  lottery_discount_bp   INTEGER NOT NULL DEFAULT 0,
  auction_day           INTEGER,
  auction_time_from     TEXT,
  auction_time_to       TEXT,
  bid_step              INTEGER,                                          -- paise, live auction room
  bid_minutes           INTEGER,
  eligibility_rule      TEXT,
  status                TEXT NOT NULL DEFAULT 'Running' CHECK (status IN ('Forming', 'Running', 'Closed')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, name)
);

-- FDR / DD lodged for the group as security.
CREATE TABLE group_deposits (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES chit_groups(id),
  kind            TEXT NOT NULL DEFAULT 'FDR' CHECK (kind IN ('FDR', 'DD')),
  number          TEXT,
  deposit_date    TEXT,
  period_months   INTEGER,
  interest_type   TEXT CHECK (interest_type IN ('simple', 'compound')),
  amount          INTEGER,                          -- paise
  rate_bp         INTEGER,
  maturity_amount INTEGER,                          -- paise
  maturity_date   TEXT,
  bank            TEXT,
  bank_branch     TEXT
);

------------------------------------------------------------------------
-- Enrollment: a person (or the company) holding a ticket in a group
------------------------------------------------------------------------

CREATE TABLE enrollments (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id),
  group_id              TEXT NOT NULL REFERENCES chit_groups(id),
  ticket_no             INTEGER NOT NULL CHECK (ticket_no > 0),
  person_id             TEXT REFERENCES persons(id),       -- null when is_company = 1
  is_company            INTEGER NOT NULL DEFAULT 0,        -- company-held ticket; cannot win
  enrolment_date        TEXT,
  business_agent_id     TEXT REFERENCES persons(id),
  collection_agent_id   TEXT REFERENCES persons(id),
  guarantor1_id         TEXT REFERENCES persons(id),
  guarantor2_id         TEXT REFERENCES persons(id),
  nominee_name          TEXT,
  nominee_relation      TEXT,
  nominee_address       TEXT,
  zone                  TEXT,
  area                  TEXT,
  director              TEXT,
  payment_mode          TEXT,
  pass_book_no          TEXT,
  agreement_done        INTEGER NOT NULL DEFAULT 0,
  intimation_card_done  INTEGER NOT NULL DEFAULT 0,
  introducer_incentive  INTEGER,                           -- paise
  status                TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Removed')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((is_company = 1 AND person_id IS NULL) OR (is_company = 0 AND person_id IS NOT NULL))
);
-- Only one active holder per ticket; removed tickets keep their history.
CREATE UNIQUE INDEX enrollments_active_ticket ON enrollments (group_id, ticket_no) WHERE status = 'Active';
CREATE INDEX enrollments_person ON enrollments (person_id);
CREATE INDEX enrollments_agent ON enrollments (collection_agent_id);

-- Ticket transferred from one member to another.
CREATE TABLE ticket_transfers (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  transfer_no     INTEGER NOT NULL,
  transfer_date   TEXT NOT NULL,
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id),
  from_person_id  TEXT REFERENCES persons(id),
  to_person_id    TEXT NOT NULL REFERENCES persons(id),
  paid_till_now   INTEGER NOT NULL DEFAULT 0,       -- paise, snapshot at transfer
  balance         INTEGER NOT NULL DEFAULT 0,
  fee             INTEGER NOT NULL DEFAULT 0,
  fee_receipt_id  TEXT,
  reason          TEXT,
  created_by      TEXT REFERENCES users(id),
  UNIQUE (company_id, transfer_no)
);

-- Member removal (cancellation) and the refund worked out for it.
CREATE TABLE member_removals (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id),
  enrollment_id     TEXT NOT NULL REFERENCES enrollments(id),
  removal_date      TEXT NOT NULL,
  reason            TEXT,
  paid_amount       INTEGER NOT NULL DEFAULT 0,     -- paise, total paid before removal
  charge_type       TEXT,                           -- percent or fixed
  charge_value      INTEGER NOT NULL DEFAULT 0,
  commission        INTEGER NOT NULL DEFAULT 0,
  other_deductions  INTEGER NOT NULL DEFAULT 0,
  total_deducted    INTEGER NOT NULL DEFAULT 0,
  refund_due        INTEGER NOT NULL DEFAULT 0,
  voucher_series    TEXT NOT NULL DEFAULT 'CRF',
  voucher_no        INTEGER,
  remark            TEXT,
  created_by        TEXT REFERENCES users(id)
);

------------------------------------------------------------------------
-- Auctions and prize payments
------------------------------------------------------------------------

CREATE TABLE auctions (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id),
  group_id              TEXT NOT NULL REFERENCES chit_groups(id),
  auction_no            INTEGER NOT NULL,
  auction_date          TEXT NOT NULL,
  due_date              TEXT,
  next_auction_date     TEXT,
  winner_enrollment_id  TEXT REFERENCES enrollments(id),
  winner_ticket_no      INTEGER,
  decided_by            TEXT NOT NULL CHECK (decided_by IN ('bidding', 'bid offer', 'proxy', 'lottery', 'company')),
  company_won           INTEGER NOT NULL DEFAULT 0,
  -- figures fixed at the time of the auction (paise)
  bid                   INTEGER NOT NULL,           -- bid loss / discount
  commission            INTEGER NOT NULL,
  gst_bp                INTEGER NOT NULL DEFAULT 0,
  gst                   INTEGER NOT NULL DEFAULT 0,
  bid_payable           INTEGER NOT NULL,           -- chit amount - bid
  net_prize             INTEGER NOT NULL,           -- bid payable - GST
  dividend_pool         INTEGER NOT NULL,           -- bid - commission
  dividend_per_ticket   INTEGER NOT NULL,
  net_payable_per_ticket INTEGER NOT NULL,          -- installment - dividend
  minutes_filed_on      TEXT,
  status                TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Reauctioned')),
  replaced_by_id        TEXT REFERENCES auctions(id),
  reauction_reason      TEXT,
  created_by            TEXT REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX auctions_active_no ON auctions (group_id, auction_no) WHERE status = 'Active';
-- A ticket wins only once.
CREATE UNIQUE INDEX auctions_one_win ON auctions (winner_enrollment_id) WHERE status = 'Active' AND winner_enrollment_id IS NOT NULL;

-- Bids placed in the live auction room.
CREATE TABLE auction_bids (
  id              TEXT PRIMARY KEY,
  auction_id      TEXT REFERENCES auctions(id),
  group_id        TEXT NOT NULL REFERENCES chit_groups(id),
  auction_no      INTEGER NOT NULL,
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id),
  amount          INTEGER NOT NULL,                 -- paise
  source          TEXT NOT NULL DEFAULT 'office' CHECK (source IN ('office', 'member app', 'proxy')),
  at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Money advanced to a prized member before the full prize is paid.
CREATE TABLE bid_advances (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  auction_id      TEXT NOT NULL REFERENCES auctions(id),
  advance_date    TEXT NOT NULL,
  mode            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  reference       TEXT,
  bank_account_id TEXT,
  narration       TEXT,
  cancelled       INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users(id)
);

-- Prize (bid payable) paid to the winner, in one or more parts.
CREATE TABLE prize_payments (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  auction_id          TEXT NOT NULL REFERENCES auctions(id),
  payment_date        TEXT NOT NULL,
  mode                TEXT NOT NULL,
  amount              INTEGER NOT NULL,             -- paise, paid out
  adjusted_to_dues    INTEGER NOT NULL DEFAULT 0,   -- kept back against the winner's own dues
  adjusted_advance    INTEGER NOT NULL DEFAULT 0,   -- bid advance already given
  reference           TEXT,                         -- cheque / UTR no
  cheque_date         TEXT,
  bank_account_id     TEXT,
  paid_to             TEXT,
  narration           TEXT,
  voucher_series      TEXT NOT NULL DEFAULT 'BPY',
  voucher_no          INTEGER NOT NULL,
  old_no              TEXT,
  cancelled           INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, voucher_series, voucher_no)
);

------------------------------------------------------------------------
-- Collections
------------------------------------------------------------------------

CREATE TABLE receipts (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  receipt_no          INTEGER NOT NULL,
  receipt_date        TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'daily', 'advance', 'adjustment', 'online')),
  mode                TEXT NOT NULL,                -- Cash, Cheque, D.D., RTGS/NEFT, UPI, or an adjustment mode
  group_id            TEXT NOT NULL REFERENCES chit_groups(id),
  enrollment_id       TEXT NOT NULL REFERENCES enrollments(id),
  person_id           TEXT REFERENCES persons(id),  -- payer at the time (tickets can be transferred)
  collection_agent_id TEXT REFERENCES persons(id),
  tr_book_no          TEXT,
  tr_date             TEXT,
  -- amounts in paise
  amount              INTEGER NOT NULL CHECK (amount >= 0),  -- toward installments
  penalty             INTEGER NOT NULL DEFAULT 0,
  enrolment_fee       INTEGER NOT NULL DEFAULT 0,
  bank_charge         INTEGER NOT NULL DEFAULT 0,
  other_charge        INTEGER NOT NULL DEFAULT 0,
  handling_charge     INTEGER NOT NULL DEFAULT 0,   -- 2% internet handling charge on online payments
  -- cheque / DD
  cheque_no           TEXT,
  cheque_bank         TEXT,
  cheque_date         TEXT,
  cheque_place        TEXT,
  cheque_status       TEXT CHECK (cheque_status IN ('Pending', 'Cleared', 'Returned')),
  debit_account_id    TEXT,                         -- cash or bank ledger the money went into
  gateway_ref         TEXT,                         -- Razorpay payment id
  reason              TEXT,
  old_no              TEXT,                         -- receipt no in the old software
  cancelled           INTEGER NOT NULL DEFAULT 0,
  cancelled_at        TEXT,
  cancelled_by        TEXT REFERENCES users(id),
  cancel_reason       TEXT,
  sms_sent_at         TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, receipt_no)
);
CREATE INDEX receipts_ticket ON receipts (enrollment_id, receipt_date);
CREATE INDEX receipts_date ON receipts (company_id, receipt_date);
CREATE INDEX receipts_agent ON receipts (collection_agent_id, receipt_date);

-- Which installments a receipt paid, and how much of each.
CREATE TABLE receipt_installments (
  receipt_id      TEXT NOT NULL REFERENCES receipts(id),
  installment_no  INTEGER NOT NULL,
  amount          INTEGER NOT NULL,                 -- paise
  PRIMARY KEY (receipt_id, installment_no)
);

-- Money taken before a group starts, adjusted into tickets later or refunded.
CREATE TABLE future_receipts (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  future_no           INTEGER NOT NULL,
  receipt_date        TEXT NOT NULL,
  mode                TEXT NOT NULL,
  person_id           TEXT NOT NULL REFERENCES persons(id),
  collection_agent_id TEXT REFERENCES persons(id),
  tr_book_no          TEXT,
  amount              INTEGER NOT NULL,
  cheque_no           TEXT,
  cheque_bank         TEXT,
  cheque_date         TEXT,
  debit_account_id    TEXT,
  note                TEXT,
  cancelled           INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT REFERENCES users(id),
  UNIQUE (company_id, future_no)
);

CREATE TABLE future_receipt_adjustments (
  id                  TEXT PRIMARY KEY,
  future_receipt_id   TEXT NOT NULL REFERENCES future_receipts(id),
  kind                TEXT NOT NULL CHECK (kind IN ('adjusted', 'refunded')),
  adjust_date         TEXT NOT NULL,
  amount              INTEGER NOT NULL,
  deduction           INTEGER NOT NULL DEFAULT 0,
  receipt_id          TEXT REFERENCES receipts(id), -- the receipt it was adjusted into
  note                TEXT,
  cancelled           INTEGER NOT NULL DEFAULT 0
);

-- Post-dated cheques held for a ticket.
CREATE TABLE post_dated_cheques (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES companies(id),
  pdc_no              INTEGER NOT NULL,
  enrollment_id       TEXT NOT NULL REFERENCES enrollments(id),
  cheque_date         TEXT NOT NULL,
  cheque_no           TEXT NOT NULL,
  bank                TEXT,
  place               TEXT,
  collection_agent_id TEXT REFERENCES persons(id),
  amount              INTEGER NOT NULL,
  received_on         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Deposited', 'Returned', 'Cancelled')),
  receipt_id          TEXT REFERENCES receipts(id),
  note                TEXT,
  created_by          TEXT REFERENCES users(id),
  UNIQUE (company_id, pdc_no)
);
CREATE INDEX pdc_due ON post_dated_cheques (company_id, status, cheque_date);

-- Cash denomination count for a day.
CREATE TABLE cash_denominations (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  count_date    TEXT NOT NULL,
  counts_json   TEXT NOT NULL,                      -- {"500":12,"200":5,...}
  total         INTEGER NOT NULL,                   -- paise
  created_by    TEXT REFERENCES users(id)
);

-- Calls to make: remarks, call-back date, promise to pay.
CREATE TABLE follow_up_calls (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  enrollment_id   TEXT NOT NULL REFERENCES enrollments(id),
  called_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  remark          TEXT,
  next_call_date  TEXT,
  promise_date    TEXT,
  promise_amount  INTEGER,
  balance_then    INTEGER,
  created_by      TEXT REFERENCES users(id)
);
CREATE INDEX calls_next ON follow_up_calls (company_id, next_call_date);

------------------------------------------------------------------------
-- Agents
------------------------------------------------------------------------

CREATE TABLE agent_commission_rules (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  agent_id      TEXT REFERENCES persons(id),        -- null = default for all agents
  group_id      TEXT REFERENCES chit_groups(id),    -- null = all groups
  basis         TEXT NOT NULL CHECK (basis IN ('business', 'collection')),
  rate_bp       INTEGER,
  fixed_amount  INTEGER,
  tds_bp        INTEGER NOT NULL DEFAULT 0,
  from_date     TEXT,
  to_date       TEXT
);

------------------------------------------------------------------------
-- Accounts
------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  account_group   TEXT NOT NULL CHECK (account_group IN ('Assets', 'Liabilities', 'Income', 'Expenses')),
  sub_group       TEXT,
  opening_balance INTEGER NOT NULL DEFAULT 0,       -- paise
  opening_side    TEXT NOT NULL CHECK (opening_side IN ('Dr', 'Cr')),
  opening_date    TEXT,
  is_system       INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  note            TEXT,
  UNIQUE (company_id, code)
);

CREATE TABLE bank_accounts (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id),
  ledger_account_id TEXT REFERENCES ledger_accounts(id),
  bank              TEXT NOT NULL,
  branch            TEXT,
  account_no        TEXT NOT NULL,
  ifsc              TEXT,
  opening_balance   INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, account_no)
);

-- Every money event (receipt, prize payment, expense) posts a balanced voucher.
CREATE TABLE vouchers (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  series        TEXT NOT NULL,                      -- RCT, BPY, CRF, CMP, JV
  voucher_no    INTEGER NOT NULL,
  voucher_date  TEXT NOT NULL,
  source_table  TEXT,                               -- receipts, prize_payments, ...
  source_id     TEXT,
  narration     TEXT,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, series, voucher_no)
);
CREATE INDEX vouchers_source ON vouchers (source_table, source_id);

CREATE TABLE voucher_lines (
  voucher_id        TEXT NOT NULL REFERENCES vouchers(id),
  line_no           INTEGER NOT NULL,
  ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id),
  debit             INTEGER NOT NULL DEFAULT 0,     -- paise
  credit            INTEGER NOT NULL DEFAULT 0,
  group_id          TEXT REFERENCES chit_groups(id),
  enrollment_id     TEXT REFERENCES enrollments(id),
  PRIMARY KEY (voucher_id, line_no),
  CHECK ((debit = 0) <> (credit = 0))
);
CREATE INDEX voucher_lines_ledger ON voucher_lines (ledger_account_id);

------------------------------------------------------------------------
-- Audit trail: every create, change, cancel and delete, kept permanently
------------------------------------------------------------------------

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'cancel', 'delete', 'import', 'login', 'export')),
  entity      TEXT NOT NULL,                        -- table name
  entity_id   TEXT,
  summary     TEXT,                                 -- 'Receipt 1042: Rs 21,250 ticket 7 of JP-14'
  old_json    TEXT,
  new_json    TEXT
);
CREATE INDEX audit_entity ON audit_log (entity, entity_id);
CREATE INDEX audit_time ON audit_log (company_id, at);
