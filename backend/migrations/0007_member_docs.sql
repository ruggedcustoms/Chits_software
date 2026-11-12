-- Surety documents a prized subscriber sends from the member app; the office accepts or rejects each one.
-- Files are small: photos shrunk on the phone, PDFs up to 1 MB, kept as data: URLs (one row each).

CREATE TABLE member_docs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  person_id     TEXT NOT NULL REFERENCES persons(id),
  enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
  doc_type      TEXT NOT NULL,
  other_name    TEXT,                              -- what it is, when the type is Other
  file_name     TEXT,
  mime          TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'application/pdf')),
  data          TEXT NOT NULL,
  size          INTEGER NOT NULL,                  -- bytes of the file
  status        TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Accepted', 'Rejected')),
  reason        TEXT,                              -- why it was rejected
  submitted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at   TEXT,
  reviewed_by   TEXT REFERENCES users(id)
);
CREATE INDEX member_docs_company ON member_docs (company_id, status, submitted_at);
CREATE INDEX member_docs_enrollment ON member_docs (enrollment_id);
