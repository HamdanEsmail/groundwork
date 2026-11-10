-- Public watch removal is restricted to the visitor who created the watch.
ALTER TABLE watches ADD COLUMN owner_hash TEXT;

-- Failed object deletions remain queued for the next maintenance run.
CREATE TABLE pending_evidence_deletions (evidence_key TEXT PRIMARY KEY);

-- A Monitor run is recorded once, including concurrent deliveries.
CREATE UNIQUE INDEX idx_monitor_check_run ON spend (ref) WHERE kind = 'monitor_check' AND ref LIKE 'monitor:%';

-- Certification expiry compares consecutive L&I reads.
ALTER TABLE parcels ADD COLUMN li_checked_at TEXT;

-- Only one delivery per Monitor may update parcel memory at a time.
CREATE TABLE monitor_processing (monitor_id TEXT PRIMARY KEY, holder TEXT NOT NULL, started_at TEXT NOT NULL);
