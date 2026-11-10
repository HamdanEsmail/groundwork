// Dossiers: one row per build. The JSON columns (`units`, `resolution_detail`) are stringified on
// write and parsed on read; times are stored as millisecond ISO UTC so SQL can compare them as text.
import type { Units } from "../address/resolve";
import { FREE_SECTION_IDS } from "../sections/index";
import { parseJsonColumn } from "./json";
import { bindFields, encodeValues, field, json, plain, requireGiven, time, updateSql } from "./patch";
import { isoTime } from "./time";
import type { AddedBy, Dossier, DossierRow, DossierStatus, Resolution, ResolutionDetail, ResolveOutcome, Tier } from "./types";

export interface NewDossier {
  /** Generated (a UUID) when absent. */
  id?: string;
  address_input?: string | null;
  address_resolved?: string | null;
  opa_account?: string | null;
  unit?: string | null;
  resolution?: Resolution | null;
  outcome?: ResolveOutcome | null;
  tier: Tier;
  status: DossierStatus;
  /** The dossier whose sections this one copied (a cache hit, C7). */
  cached_from?: string | null;
  ip_hash?: string | null;
  added_by: AddedBy;
  /** Defaults to now. */
  created_at?: string;
  completed_at?: string | null;
  /** Defaults to 0. */
  spend_usd?: number;
  expires_at?: string | null;
  workflow_id?: string | null;
  workflow_started_at?: string | null;
  callback_url?: string | null;
  units?: Units | null;
  resolution_detail?: ResolutionDetail | null;
}

/** The columns a build changes after the row exists. Who asked, when and from where (`id`, `added_by`,
 *  `created_at`, `ip_hash`, `address_input`) and `cached_from` are fixed at insert. */
export interface DossierPatch {
  address_resolved?: string | null;
  opa_account?: string | null;
  unit?: string | null;
  resolution?: Resolution | null;
  outcome?: ResolveOutcome | null;
  tier?: Tier;
  status?: DossierStatus;
  completed_at?: string | null;
  spend_usd?: number;
  expires_at?: string | null;
  workflow_id?: string | null;
  workflow_started_at?: string | null;
  callback_url?: string | null;
  units?: Units | null;
  resolution_detail?: ResolutionDetail | null;
}

const PATCHABLE = [
  field("address_resolved"),
  field("opa_account"),
  field("unit"),
  field("resolution"),
  field("outcome"),
  field("tier", plain, { required: true }),
  field("status", plain, { required: true }),
  field("completed_at", time),
  field("spend_usd", plain, { required: true }),
  field("expires_at", time),
  field("workflow_id"),
  field("workflow_started_at", time),
  field("callback_url"),
  field("units", json),
  field("resolution_detail", json),
];

const INSERTABLE = [
  field("address_input"),
  field("address_resolved"),
  field("opa_account"),
  field("unit"),
  field("resolution"),
  field("outcome"),
  field("tier", plain, { required: true }),
  field("status", plain, { required: true }),
  field("cached_from"),
  field("ip_hash"),
  field("added_by", plain, { required: true }),
  field("created_at", time, { required: true }),
  field("completed_at", time),
  field("spend_usd", plain, { required: true }),
  field("expires_at", time),
  field("workflow_id"),
  field("workflow_started_at", time),
  field("callback_url"),
  field("units", json),
  field("resolution_detail", json),
];

const INSERT_SQL = `INSERT INTO dossiers (id, ${INSERTABLE.map((f) => f.name).join(", ")}) VALUES (${["id", ...INSERTABLE].map((_, i) => `?${1 + i}`).join(", ")})`;
const UPDATE_SQL = updateSql("dossiers", "id", PATCHABLE);

// A row `insertDossier` wrote has a value in every column `Dossier` types as non-null (it requires or
// defaults each), so the cast from the nullable row type holds for every row the repositories read.
function toDossier(row: DossierRow): Dossier {
  return {
    ...row,
    units: parseJsonColumn<Units>(row.units, "dossiers.units"),
    resolution_detail: parseJsonColumn<ResolutionDetail>(row.resolution_detail, "dossiers.resolution_detail"),
  } as Dossier;
}

/** Inserts a dossier and returns its id. `created_at` is now and `spend_usd` 0 unless given. */
export async function insertDossier(db: D1Database, d: NewDossier): Promise<string> {
  const id = d.id ?? crypto.randomUUID();
  const { id: _id, ...rest } = d;
  const given = { created_at: new Date().toISOString(), spend_usd: 0, ...stripUndefined(rest) };
  requireGiven(INSERTABLE, given, "insertDossier");
  const values = encodeValues(INSERTABLE, given, "insertDossier", "writable");
  await db.prepare(INSERT_SQL).bind(id, ...values).run();
  return id;
}

/** Drops keys whose value is undefined, so a default is not overridden by an explicit `undefined`. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function getDossier(db: D1Database, id: string): Promise<Dossier | null> {
  const row = await db.prepare("SELECT * FROM dossiers WHERE id = ?").bind(id).first<DossierRow>();
  return row === null ? null : toDossier(row);
}

/**
 * Changes the given columns of one dossier and no others (a column given as null is cleared). True when
 * the row exists and was updated; false for an unknown id or an empty patch. Throws on a column that is
 * not patchable.
 */
export async function updateDossier(db: D1Database, id: string, patch: DossierPatch): Promise<boolean> {
  const binds = bindFields([id], PATCHABLE, patch, "updateDossier", "patchable");
  if (Object.values(patch).every((v) => v === undefined)) return false;
  const result = await db.prepare(UPDATE_SQL).bind(...binds).run();
  return result.meta.changes > 0;
}

const TIER_RANK: Record<Tier, number> = { free: 0, standard: 1, deep: 2 };
const FREE_ID_PARAMS = FREE_SECTION_IDS.map((_, i) => `?${4 + i}`).join(", ");
const FIND_CACHED_SQL = `
  SELECT d.* FROM dossiers d
  WHERE d.opa_account = ?1
    AND d.created_at >= ?2
    AND d.cached_from IS NULL
    AND d.status IN ('complete', 'partial')
    AND CASE d.tier WHEN 'free' THEN 0 WHEN 'standard' THEN 1 WHEN 'deep' THEN 2 ELSE -1 END >= ?3
    AND (SELECT COUNT(*) FROM sections s
         WHERE s.dossier_id = d.id AND s.status IN ('ok', 'empty') AND s.section_id IN (${FREE_ID_PARAMS})) = ${FREE_SECTION_IDS.length}
  ORDER BY d.created_at DESC, d.rowid DESC
  LIMIT 1`;

/**
 * The most recent dossier for this OPA account that a new request can reuse: built within the last
 * `withinHours` (a dossier created exactly that long ago still counts), `complete` or `partial` (never
 * `failed`), of at least tier `minTier`, with each of the four free sections `ok` or `empty` (a clean
 * property's licences page is legitimately empty; `error`, `unavailable` and `pending` disqualify), and not
 * itself a cache copy (a copy would carry old data into a fresh window). Null when there is none.
 *
 * The caller decides what a hit means: a `complete` one gets a new row with `cached_from` and copied
 * sections; a `partial` one is still running, so its id is returned as it is, without a copy.
 */
export async function findCachedDossier(
  db: D1Database,
  opa: string,
  withinHours: number,
  opts: { minTier: Tier; now?: Date },
): Promise<Dossier | null> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - withinHours * 3_600_000).toISOString();
  const row = await db
    .prepare(FIND_CACHED_SQL)
    .bind(opa, since, TIER_RANK[opts.minTier], ...FREE_SECTION_IDS)
    .first<DossierRow>();
  return row === null ? null : toDossier(row);
}

// Every section column but the dossier id, which the copy takes from its own parameter.
const COPY_COLUMNS = "section_id, status, method, source_url, checked_at, evidence_key, data, raw_key, run_id, error, spend_usd, rows_returned, depth";
const COPY_SQL = `INSERT INTO sections (dossier_id, ${COPY_COLUMNS}) SELECT ?2, ${COPY_COLUMNS} FROM sections WHERE dossier_id = ?1`;

/**
 * Copies every section row of one dossier to another in one statement: same status, checked_at, data,
 * evidence_key, run_id, spend and the rest, so evidence objects are shared, not copied. Returns the number
 * of rows copied. Fails if the target already has one of those sections.
 */
export async function copySections(db: D1Database, fromDossierId: string, toDossierId: string): Promise<number> {
  const result = await db.prepare(COPY_SQL).bind(fromDossierId, toDossierId).run();
  return result.meta.changes;
}

/**
 * The OPA accounts that may appear on a public surface: those with a curated dossier, and those with an
 * active watch set with the admin token. A watch a visitor starts makes nothing public.
 */
export const PUBLIC_OPAS_SQL = `
  SELECT opa_account FROM dossiers WHERE added_by = 'curated' AND opa_account IS NOT NULL
  UNION
  SELECT opa_account FROM watches
  WHERE status = 'active' AND added_by IN ('admin', 'curated') AND opa_account IS NOT NULL`;

export async function listPublicOpas(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare(PUBLIC_OPAS_SQL).all<{ opa_account: string }>();
  return new Set(results.map((r) => r.opa_account));
}

// A visitor's dossier is never listed, even of a public account: it carries what that visitor typed.
const PUBLIC_DOSSIERS_SQL = `
  SELECT d.* FROM dossiers d
  WHERE d.added_by = 'curated'
     OR (d.added_by = 'admin' AND d.opa_account IN (${PUBLIC_OPAS_SQL}))
  ORDER BY d.created_at DESC, d.rowid DESC`;

/** Curated dossiers, and admin dossiers of a public account, newest first (the export). */
export async function listPublicDossiers(db: D1Database): Promise<Dossier[]> {
  const { results } = await db.prepare(PUBLIC_DOSSIERS_SQL).all<DossierRow>();
  return results.map(toDossier);
}

/** The dossiers of one account that a public reader may see (none of them a visitor's), newest first. */
export async function listPublicDossiersOf(db: D1Database, opa: string): Promise<Dossier[]> {
  const { results } = await db
    .prepare("SELECT * FROM dossiers WHERE opa_account = ? AND added_by IN ('curated', 'admin') ORDER BY created_at DESC, rowid DESC")
    .bind(opa)
    .all<DossierRow>();
  return results.map(toDossier);
}

// A public dossier past its expiry whose OPA account has no active watch. Curated and admin rows never match.
const EXPIRED_PUBLIC = `SELECT d.id FROM dossiers d
  WHERE d.id IS NOT NULL AND d.added_by = 'public' AND d.expires_at IS NOT NULL AND d.expires_at <= ?1
    AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.opa_account = d.opa_account AND w.status = 'active')`;
const EXPIRED_IDS_SQL = `${EXPIRED_PUBLIC} ORDER BY d.created_at, d.rowid`;
// Evidence keys of the sections about to go that no section outside the deleted set refers to.
const UNREFERENCED_KEYS_SQL = `
  SELECT DISTINCT s.evidence_key AS evidence_key FROM sections s
  WHERE s.evidence_key IS NOT NULL
    AND s.dossier_id IN (${EXPIRED_PUBLIC})
    AND NOT EXISTS (SELECT 1 FROM sections o WHERE o.evidence_key = s.evidence_key AND o.dossier_id NOT IN (${EXPIRED_PUBLIC}))
  ORDER BY s.evidence_key`;
const DELETE_SECTIONS_SQL = `DELETE FROM sections WHERE dossier_id IN (${EXPIRED_PUBLIC})`;
const DELETE_DOSSIERS_SQL = `DELETE FROM dossiers WHERE id IN (${EXPIRED_PUBLIC})`;

/**
 * Deletes the public dossiers whose `expires_at` is at or before `nowIso` and whose OPA account has no
 * active watch, together with their section rows, and returns the deleted ids (oldest first) and the
 * evidence keys of the deleted sections that no remaining section still references (sorted, once each).
 * The caller deletes those R2 objects. Curated and admin dossiers are never touched.
 *
 * One `db.batch`, so it is a single transaction: the two reads and the two deletes see the same rows, and
 * a failure part-way leaves everything as it was (no section row is left pointing at a deleted dossier).
 */
export async function expirePublicDossiers(db: D1Database, nowIso: string): Promise<{ ids: string[]; evidenceKeys: string[] }> {
  const now = isoTime(nowIso);
  const [ids, keys] = await db.batch<Record<string, string>>([
    db.prepare(EXPIRED_IDS_SQL).bind(now),
    db.prepare(UNREFERENCED_KEYS_SQL).bind(now),
    db.prepare(`INSERT OR IGNORE INTO pending_evidence_deletions (evidence_key) ${UNREFERENCED_KEYS_SQL}`).bind(now),
    db.prepare(DELETE_SECTIONS_SQL).bind(now),
    db.prepare(DELETE_DOSSIERS_SQL).bind(now),
  ]);
  return {
    ids: (ids?.results ?? []).map((r) => r.id),
    evidenceKeys: (keys?.results ?? []).map((r) => r.evidence_key),
  };
}
