-- The last Monitor run applied for a watch, so an older delivery cannot roll parcel memory back.
ALTER TABLE watches ADD COLUMN last_applied_at TEXT;
