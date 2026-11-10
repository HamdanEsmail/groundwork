// Events: what a Monitor report changed on a parcel. They belong to the OPA account, and only watched
// parcels are ever reported on.
import type { EventKind } from "../sections/types";
import { parseJsonColumn, toJson } from "./json";
import { isoTime, isoTimeOrNull } from "./time";
import type { EventRow, StoredEvent } from "./types";

export interface NewEvent {
  /** Generated (a UUID) when absent. */
  id?: string;
  opa_account: string | null;
  kind: EventKind;
  summary: string;
  /** The rows that changed; stored as JSON, `[]` when absent. */
  rows?: unknown[];
  /** Stored as JSON text. */
  before?: unknown;
  after?: unknown;
  source_url?: string | null;
  monitor_run_id?: string | null;
  notified_at?: string | null;
  /** Defaults to now. */
  at?: string;
}

function toEvent(row: EventRow): StoredEvent {
  const rows = parseJsonColumn<unknown>(row.rows, "events.rows");
  return {
    ...row,
    rows: Array.isArray(rows) ? rows : [],
    before: parseJsonColumn<unknown>(row.before, "events.before"),
    after: parseJsonColumn<unknown>(row.after, "events.after"),
  };
}

/** Inserts an event and returns its id. `rows`, `before` and `after` are stringified here; `at` and
 *  `notified_at` are stored as millisecond ISO (an unparseable time throws). */
export async function insertEvent(db: D1Database, e: NewEvent): Promise<string> {
  const id = e.id ?? crypto.randomUUID();
  const at = e.at === undefined ? new Date().toISOString() : isoTime(e.at);
  await db
    .prepare(
      `INSERT INTO events (id, opa_account, kind, summary, rows, before, after, source_url, monitor_run_id, at, notified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      e.opa_account,
      e.kind,
      e.summary,
      JSON.stringify(e.rows ?? []),
      toJson(e.before),
      toJson(e.after),
      e.source_url ?? null,
      e.monitor_run_id ?? null,
      at,
      isoTimeOrNull(e.notified_at),
    )
    .run();
  return id;
}

// One fixed text; a filter that is not given is NULL and matches every row.
const LIST_SQL = `SELECT * FROM events
  WHERE (?1 IS NULL OR at >= ?1) AND (?2 IS NULL OR opa_account = ?2)
  ORDER BY at DESC, rowid DESC LIMIT ?3`;

/** The most events one `listEvents` call returns, whatever limit is asked for. */
export const MAX_EVENTS_LIMIT = 500;

/**
 * Events newest first: those at or after `since` (all when absent) and of one account (all when absent),
 * at most `limit` (capped at MAX_EVENTS_LIMIT). A limit below 1 returns nothing; it never becomes SQLite's
 * "no limit". A limit that is not a finite number (NaN, Infinity) throws a RangeError.
 */
export async function listEvents(db: D1Database, opts: { since?: string; opa?: string; limit: number }): Promise<StoredEvent[]> {
  if (!Number.isFinite(opts.limit)) throw new RangeError(`listEvents: limit must be a finite number, got ${String(opts.limit)}`);
  const limit = Math.min(MAX_EVENTS_LIMIT, Math.max(0, Math.trunc(opts.limit)));
  const { results } = await db
    .prepare(LIST_SQL)
    .bind(opts.since === undefined ? null : isoTime(opts.since), opts.opa ?? null, limit)
    .all<EventRow>();
  return results.map(toEvent);
}

/** Every event of one account, newest first. */
export async function listEventsForOpa(db: D1Database, opa: string): Promise<StoredEvent[]> {
  const { results } = await db
    .prepare("SELECT * FROM events WHERE opa_account = ? ORDER BY at DESC, rowid DESC")
    .bind(opa)
    .all<EventRow>();
  return results.map(toEvent);
}

/** Stamps the delivery time of an event the first time it is called for it; later calls change nothing.
 *  True when this call stamped it. */
export async function markNotified(db: D1Database, id: string, atIso: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE events SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
    .bind(isoTime(atIso), id)
    .run();
  return result.meta.changes > 0;
}
