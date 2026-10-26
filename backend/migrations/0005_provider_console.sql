-- The software provider (Rugged Customs) console, company licences and branding.

-- A short code for each company, used in the links on the company's own website
-- (for example ?co=mrj), so nobody types a long company id.
ALTER TABLE companies ADD COLUMN code TEXT;
CREATE UNIQUE INDEX companies_code ON companies (code);

-- After valid_till the company can still sign in and look at its data, but not change it, for this many days.
ALTER TABLE companies ADD COLUMN grace_days INTEGER NOT NULL DEFAULT 15;

-- Logo (a small image as a data URL), colours and website, shown on the company's sign-in pages.
ALTER TABLE companies ADD COLUMN brand_json TEXT NOT NULL DEFAULT '{}';

-- 1 when the provider or an owner has given a staff member a temporary password.
ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0;

-- People at the software provider. 'owner' manages companies, licences and other admins;
-- 'support' can see companies and usage, and reset a company owner's password.
-- Sign-in needs the password and a 6-digit code from an authenticator app.
CREATE TABLE platform_admins (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'support')),
  must_change     INTEGER NOT NULL DEFAULT 1,
  totp_secret     TEXT,                              -- base32; set up at the first sign-in
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  INTEGER NOT NULL DEFAULT 0,        -- a code is accepted only once
  active          INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  last_sign_in    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE platform_sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    TEXT NOT NULL REFERENCES platform_admins(id),
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX platform_sessions_admin ON platform_sessions (admin_id);

CREATE TABLE platform_audit (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT REFERENCES platform_admins(id),
  action      TEXT NOT NULL,
  company_id  TEXT,
  summary     TEXT NOT NULL,
  ip          TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX platform_audit_at ON platform_audit (at);
