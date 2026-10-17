-- Member app logins and sessions.
--
-- The office issues each member a login: the username is the member number (for example
-- M00084) and the first password is a 6-digit temporary one, which the member must change
-- at the first sign-in. member_logins from 0001 was never used (keyed by mobile, but family
-- members share a mobile), so it is replaced.

DROP TABLE IF EXISTS member_logins;

CREATE TABLE member_logins (
  person_id       TEXT PRIMARY KEY REFERENCES persons(id),
  company_id      TEXT NOT NULL REFERENCES companies(id),
  password_hash   TEXT NOT NULL,                    -- salted hash only
  must_change     INTEGER NOT NULL DEFAULT 1,       -- 1 while the temporary password is in use
  active          INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  issued_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  issued_by       TEXT REFERENCES users(id),
  last_sign_in    TEXT
);
CREATE INDEX member_logins_company ON member_logins (company_id);

-- Only a hash of the token is kept, as for staff sessions.
CREATE TABLE member_sessions (
  token_hash  TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES persons(id),
  company_id  TEXT NOT NULL REFERENCES companies(id),
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX member_sessions_person ON member_sessions (person_id);
