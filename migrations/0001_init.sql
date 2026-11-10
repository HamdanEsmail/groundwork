-- Groundwork schema. Timestamps are ISO 8601 UTC strings; ids are UUIDs.
-- JSON columns hold text produced by JSON.stringify.
-- A CHECK on a nullable column passes for NULL, so columns that are empty
-- while a row is pending (outcome, resolution, status, method, depth) still
-- carry the enum.

-- One row per dossier build. `outcome` is what address resolution found;
-- a no_match or ambiguous outcome still gets a row (status 'failed') with
-- opa_account, address_resolved and resolution empty. `status` is
-- 'partial' only while sections are still running.
CREATE TABLE dossiers (
  id TEXT PRIMARY KEY,
  address_input TEXT,
  address_resolved TEXT,
  opa_account TEXT,
  unit TEXT,
  resolution TEXT CHECK (resolution IN ('exact', 'fuzzy', 'parent')),
  outcome TEXT CHECK (outcome IN ('resolved', 'ambiguous', 'no_match')),
  tier TEXT CHECK (tier IN ('free', 'standard', 'deep')),
  status TEXT CHECK (status IN ('partial', 'complete', 'failed')),
  cached_from TEXT,
  ip_hash TEXT,
  added_by TEXT CHECK (added_by IN ('public', 'admin', 'curated')),
  created_at TEXT,
  completed_at TEXT,
  spend_usd REAL,
  expires_at TEXT,
  workflow_id TEXT,
  workflow_started_at TEXT,
  callback_url TEXT,
  -- {count, list, list_url} for a condominium parent, else NULL.
  units TEXT,
  -- {variants_tried, candidates, manual_url, resolved_to}.
  resolution_detail TEXT
);
CREATE INDEX idx_dossiers_opa_created ON dossiers (opa_account, created_at);

-- One row per (dossier, section). An Agent section the tier does not
-- include is 'skipped'; one the tier includes but has not run is 'pending'.
-- The reason for 'unavailable' and 'error' lives in `error`.
CREATE TABLE sections (
  dossier_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  status TEXT CHECK (status IN ('ok', 'empty', 'unavailable', 'pending', 'error', 'skipped')),
  method TEXT CHECK (method IN ('fetch', 'agent')),
  source_url TEXT,
  checked_at TEXT,
  evidence_key TEXT,
  data TEXT,
  raw_key TEXT,
  run_id TEXT,
  error TEXT,
  spend_usd REAL,
  rows_returned INTEGER,
  depth TEXT CHECK (depth IN ('recent', 'extended', 'full')),
  PRIMARY KEY (dossier_id, section_id)
);

-- What the Monitor last reported for a parcel; the baseline events are diffed against.
-- `last_section_data` is JSON keyed by section id.
CREATE TABLE parcels (
  opa_account TEXT PRIMARY KEY,
  address_resolved TEXT,
  last_section_data TEXT,
  updated_at TEXT
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  opa_account TEXT,
  kind TEXT CHECK (kind IN ('li', 'property')),
  monitor_id TEXT,
  added_by TEXT CHECK (added_by IN ('public', 'admin', 'curated')),
  callback_url TEXT,
  expires_at TEXT,
  status TEXT,
  created_at TEXT
);
CREATE INDEX idx_watches_opa ON watches (opa_account);
CREATE INDEX idx_watches_monitor ON watches (monitor_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  opa_account TEXT,
  kind TEXT CHECK (kind IN ('new_permit', 'new_violation', 'violation_closed', 'new_inspection', 'new_appeal', 'certification_expired', 'assessment_change', 'sale', 'other')),
  summary TEXT,
  rows TEXT,
  before TEXT,
  after TEXT,
  source_url TEXT,
  monitor_run_id TEXT,
  at TEXT,
  notified_at TEXT
);
CREATE INDEX idx_events_opa_at ON events (opa_account, at);

CREATE TABLE spend (
  id TEXT PRIMARY KEY,
  kind TEXT,
  amount_usd REAL,
  ref TEXT,
  at TEXT
);

-- Per-visitor daily counters for the public rate limits.
CREATE TABLE public_use (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  dossiers INTEGER NOT NULL DEFAULT 0,
  watches INTEGER NOT NULL DEFAULT 0,
  upgrades INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);

-- The single row that says an Agent run is in flight. Only one Agent run
-- may be in flight at a time; `id = 1` makes a second row impossible.
CREATE TABLE agent_inflight (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT,
  started_at TEXT
);
