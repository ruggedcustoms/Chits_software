-- The office screens keep more details than the tables have columns for (fractions,
-- employment details, bidding window, cheque extras and so on). They are kept here as
-- JSON so nothing a user types is lost. Money, dates and anything a report adds up
-- stay in proper columns.

ALTER TABLE persons ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE chit_groups ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE enrollments ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE auctions ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE receipts ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE prize_payments ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}';
