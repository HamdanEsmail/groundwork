// Watches: one row per TinyFish Monitor Groundwork holds for an OPA account (`kind` says which page:
// the L&I tab or the property tab). Only `active` watches hold a Monitor.
import { isoTime, isoTimeOrNull } from "./time";
import type { AddedBy, WatchKind, WatchRow, WatchStatus } from "./types";

export interface NewWatch {
  /** Generated (a UUID) when absent. */
  id?: string;
  opa_account: string | null;
  kind: WatchKind;
  monitor_id: string | null;
  added_by: AddedBy;
  callback_url?: string | null;
  /** Public watches expire; admin and curated ones have none. */
  expires_at?: string | null;
  /** Defaults to `active`. */
  status?: WatchStatus;
}

export interface WatchFilter {
  opa?: string;
  status?: WatchStatus;
  addedBy?: AddedBy;
  kind?: WatchKind;
}

/** Inserts a watch and returns its id. `created_at` is now. */
export async function insertWatch(db: D1Database, w: NewWatch): Promise<string> {
  const id = w.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO watches (id, opa_account, kind, monitor_id, added_by, callback_url, expires_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      w.opa_account,
      w.kind,
      w.monitor_id,
      w.added_by,
      w.callback_url ?? null,
      isoTimeOrNull(w.expires_at),
      w.status ?? "active",
      new Date().toISOString(),
    )
    .run();
  return id;
}

export function getWatch(db: D1Database, id: string): Promise<WatchRow | null> {
  return db.prepare("SELECT * FROM watches WHERE id = ?").bind(id).first<WatchRow>();
}

/** The watch that holds this TinyFish monitor id (the webhook's routing key). */
export function getWatchByMonitorId(db: D1Database, monitorId: string): Promise<WatchRow | null> {
  return db.prepare("SELECT * FROM watches WHERE monitor_id = ? ORDER BY created_at, rowid LIMIT 1").bind(monitorId).first<WatchRow>();
}

// One fixed text; a filter that is not given is NULL and matches every row.
const LIST_SQL = `SELECT * FROM watches
  WHERE (?1 IS NULL OR opa_account = ?1) AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR added_by = ?3) AND (?4 IS NULL OR kind = ?4)
  ORDER BY created_at, rowid`;

/** Watches, oldest first, optionally only those of one account, status, adder or kind. */
export async function listWatches(db: D1Database, filter: WatchFilter = {}): Promise<WatchRow[]> {
  const { results } = await db
    .prepare(LIST_SQL)
    .bind(filter.opa ?? null, filter.status ?? null, filter.addedBy ?? null, filter.kind ?? null)
    .all<WatchRow>();
  return results;
}

/** Sets one watch's status. True when the watch exists. */
export async function setWatchStatus(db: D1Database, id: string, status: WatchStatus): Promise<boolean> {
  const result = await db.prepare("UPDATE watches SET status = ? WHERE id = ?").bind(status, id).run();
  return result.meta.changes > 0;
}

// Soonest-expired first; same-instant watches in insertion order.
const DUE_SQL = `SELECT * FROM watches
  WHERE status = 'active' AND monitor_id IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?1
  ORDER BY expires_at, rowid`;

/**
 * The watches whose time is up: active, holding a Monitor, `expires_at` at or before `nowIso`. Writes
 * nothing. The expiry protocol (the hourly cron):
 *
 *   for each watch returned: delete its TinyFish monitor, and only after that succeeds call
 *   `setWatchStatus(db, watch.id, "expired")`.
 *
 * A watch stays `active` until its Monitor is gone, so a failed delete leaves it here to be retried on the
 * next run and keeps counting in `countMonitors` (TinyFish still holds that monitor). Flipping the status
 * first would free the slot while the monitor still exists, or lose the watch for good if the delete failed.
 * An active watch with no `monitor_id` holds nothing and is not returned.
 */
export async function dueForExpiry(db: D1Database, nowIso: string): Promise<WatchRow[]> {
  const { results } = await db.prepare(DUE_SQL).bind(isoTime(nowIso)).all<WatchRow>();
  return results;
}

// A watch holds a TinyFish monitor from creation until the cron has deleted it and flagged the watch, so
// the test is status and monitor id only: a watch past `expires_at` that is still `active` still counts.
const HOLDING = "status = 'active' AND monitor_id IS NOT NULL";

/** How many watches hold a TinyFish monitor: against `MAX_MONITORS`. Expiry is not looked at (see `dueForExpiry`). */
export async function countMonitors(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE ${HOLDING}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** `countMonitors` restricted to public watches: against `PUBLIC_WATCH_SLOTS`. Counts watch rows (one per Monitor). */
export async function countPublicWatches(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM watches WHERE added_by = 'public' AND ${HOLDING}`).first<{ n: number }>();
  return row?.n ?? 0;
}
