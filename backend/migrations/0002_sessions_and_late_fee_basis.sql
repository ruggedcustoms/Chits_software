-- Login sessions, and how a group counts its late fee.

-- Only a hash of the session token is stored, so a copy of the database cannot be used to sign in.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  company_id  TEXT NOT NULL REFERENCES companies(id),
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- 'month': rate per month, every started month counts (as in the prototype).
-- 'year':  rate per year, by the day (as in the requirements document).
ALTER TABLE chit_groups ADD COLUMN late_fee_basis TEXT NOT NULL DEFAULT 'month'
  CHECK (late_fee_basis IN ('month', 'year'));

-- When part of a prize is kept back against the winner's own dues, the receipt made for it.
ALTER TABLE prize_payments ADD COLUMN adjustment_receipt_id TEXT REFERENCES receipts(id);
