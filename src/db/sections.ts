// Section rows: one per (dossier, section). `data` is the parsed section data, stored as JSON text.
import { SECTIONS } from "../sections/index";
import type { Depth, SectionData, SectionId, SectionStatus } from "../sections/types";
import { parseJsonColumn } from "./json";
import { bindFields, field, json, plain, time, upsertSql } from "./patch";
import type { SectionRow, StoredSection } from "./types";

/** The columns `upsertSection` writes. A key left out (or undefined) is not touched; null clears it,
 *  except `status`, which is never null. */
export interface SectionFields {
  status?: SectionStatus;
  method?: "fetch" | "agent" | null;
  source_url?: string | null;
  checked_at?: string | null;
  evidence_key?: string | null;
  data?: SectionData | null;
  raw_key?: string | null;
  run_id?: string | null;
  error?: string | null;
  spend_usd?: number | null;
  rows_returned?: number | null;
  depth?: Depth | null;
}

const FIELDS = [
  field("status", plain, { required: true, insertDefault: "'pending'" }),
  field("method"),
  field("source_url"),
  field("checked_at", time),
  field("evidence_key"),
  field("data", json),
  field("raw_key"),
  field("run_id"),
  field("error"),
  field("spend_usd"),
  field("rows_returned"),
  field("depth"),
];
const UPSERT_SQL = upsertSql("sections", ["dossier_id", "section_id"], FIELDS);

/**
 * Inserts the section row, or, when it exists, changes only the fields given: a later status update does
 * not wipe the data or the evidence. A new row starts with every field not given as NULL, except `status`,
 * which starts as `pending`. Throws on a key that is not a section column (or is the row's key), and on a
 * null status.
 */
export async function upsertSection(db: D1Database, dossierId: string, sectionId: SectionId, fields: SectionFields): Promise<void> {
  const binds = bindFields([dossierId, sectionId], FIELDS, fields, "upsertSection", "writable");
  await db.prepare(UPSERT_SQL).bind(...binds).run();
}

/** Sheet order (the registry's order); an id the registry does not know sorts last. */
const SHEET_INDEX = new Map(SECTIONS.map((s, i) => [s.id as string, i]));
function bySheet(a: { section_id: string }, b: { section_id: string }): number {
  const ia = SHEET_INDEX.get(a.section_id) ?? SECTIONS.length;
  const ib = SHEET_INDEX.get(b.section_id) ?? SECTIONS.length;
  return ia - ib || a.section_id.localeCompare(b.section_id);
}

/** Every section row of a dossier, `data` parsed, in sheet order (not insertion order). */
export async function getSections(db: D1Database, dossierId: string): Promise<StoredSection[]> {
  const { results } = await db.prepare("SELECT * FROM sections WHERE dossier_id = ?").bind(dossierId).all<SectionRow>();
  // A row `upsertSection` wrote always has a status (see StoredSection).
  return results.map((r) => ({ ...r, data: parseJsonColumn<SectionData>(r.data, "sections.data") }) as StoredSection).sort(bySheet);
}

/**
 * Moves one section to a status and writes the reason with it: `error` becomes the given text, or NULL
 * when none is given, so a reason from an earlier status does not outlive it. Other fields stay. True when
 * the row exists; a missing row is not created.
 */
export async function setSectionStatus(
  db: D1Database,
  dossierId: string,
  sectionId: SectionId,
  status: SectionStatus,
  error?: string | null,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE sections SET status = ?3, error = ?4 WHERE dossier_id = ?1 AND section_id = ?2")
    .bind(dossierId, sectionId, status, error ?? null)
    .run();
  return result.meta.changes > 0;
}

/** The ids of the dossier's Agent sections that are `pending`, in sheet order. */
export async function pendingAgentSections(db: D1Database, dossierId: string): Promise<SectionId[]> {
  const { results } = await db
    .prepare("SELECT section_id FROM sections WHERE dossier_id = ? AND status = 'pending' AND method = 'agent'")
    .bind(dossierId)
    .all<{ section_id: string }>();
  return results
    .filter((r) => SHEET_INDEX.has(r.section_id))
    .sort(bySheet)
    .map((r) => r.section_id as SectionId);
}
