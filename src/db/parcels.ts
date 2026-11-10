// Parcels are the Monitor's memory (C12): the last section data it reported for an OPA account, which
// the next report is diffed against. Only watch creation and the Monitor webhook write here.
import { getSection } from "../sections/index";
import { parseJsonColumn } from "./json";
import type { SectionDataMap, SectionId } from "../sections/types";
import type { ParcelRow } from "./types";

function assertSectionId(sectionId: string): asserts sectionId is SectionId {
  if (getSection(sectionId) === undefined) throw new RangeError(`not a section id: ${JSON.stringify(sectionId)}`);
}

// One statement, so two writers for different sections of one parcel cannot overwrite each other's key
// (a read-modify-write could). The section id is checked against the registry before it reaches the path.
// `json_set` replaces the value at the key as a whole; it does not merge fields into the old section.
const UPSERT_SQL = `
  INSERT INTO parcels (opa_account, address_resolved, last_section_data, updated_at, li_checked_at)
  VALUES (?1, ?2, json_object(?3, json(?4)), ?5, CASE WHEN ?3 = 'licenses_inspections' THEN ?5 END)
  ON CONFLICT (opa_account) DO UPDATE SET
    last_section_data = json_set(COALESCE(parcels.last_section_data, '{}'), '$."' || ?3 || '"', json(?4)),
    address_resolved = COALESCE(?2, parcels.address_resolved),
    updated_at = ?5,
    li_checked_at = CASE WHEN ?3 = 'licenses_inspections' THEN ?5 ELSE parcels.li_checked_at END`;

/**
 * Stores one section's data for the parcel, replacing that section's earlier data and leaving the other
 * sections as they were (writing `licenses_inspections` keeps `property`). Sets `updated_at`; sets
 * `address_resolved` only when one is given. Throws when `sectionId` is not in the registry.
 */
export async function upsertParcelSection<K extends SectionId>(
  db: D1Database,
  opa: string,
  sectionId: K,
  data: SectionDataMap[K],
  addressResolved?: string | null,
): Promise<void> {
  assertSectionId(sectionId);
  await db
    .prepare(UPSERT_SQL)
    .bind(opa, addressResolved ?? null, sectionId, JSON.stringify(data), new Date().toISOString())
    .run();
}

/** The data last stored for this section of the parcel, or null when there is none. */
export async function getParcelSection<K extends SectionId>(db: D1Database, opa: string, sectionId: K): Promise<SectionDataMap[K] | null> {
  assertSectionId(sectionId);
  const row = await db.prepare("SELECT last_section_data FROM parcels WHERE opa_account = ?").bind(opa).first<Pick<ParcelRow, "last_section_data">>();
  if (row === null || row.last_section_data === null) return null;
  const all = parseJsonColumn<Record<string, unknown>>(row.last_section_data, "parcels.last_section_data");
  if (all === null || typeof all !== "object") return null;
  return Object.hasOwn(all, sectionId) ? ((all[sectionId] ?? null) as SectionDataMap[K] | null) : null;
}
