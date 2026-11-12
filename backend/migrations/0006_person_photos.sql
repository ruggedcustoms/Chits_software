-- Member photos, kept apart from persons so lists and the office's full load stay small.
-- The member app saves a photo once (taken with the phone camera); after that only the office can replace it.

CREATE TABLE person_photos (
  person_id  TEXT PRIMARY KEY REFERENCES persons(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  photo      TEXT NOT NULL,                         -- small JPEG as a data: URL
  source     TEXT NOT NULL CHECK (source IN ('member', 'office')),
  taken_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  taken_by   TEXT                                   -- staff user id when the office set it
);
CREATE INDEX person_photos_company ON person_photos (company_id);
