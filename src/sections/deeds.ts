// Deeds and parcel: atlas /deeds (Department of Records). Not watched.
import { atlasUrl } from "../tinyfish/fetch";
import {
  UnrecognisedPage,
  activeParcels,
  cell,
  findSection,
  keyValues,
  measure,
  orNull,
  orUnrecognised,
  pageKeyValues,
  pageTitle,
  records,
  splitSections,
  usDate,
  valueOf,
  yesNo,
} from "./markdown";
import type { DeedsData, SectionAdapter } from "./types";

// The atlas shows "12/30/1899", a zero-date placeholder, as the Inactive Date of an active parcel.
const PLACEHOLDER_DATE = "12/30/1899";

const DOCUMENT_COLUMNS = ["ID", "Date", "Type", "Grantor", "Grantee", "Unit #"];

function readDeeds(markdown: string): DeedsData {
  const page = splitSections(markdown);
  const kv = pageKeyValues(page);
  const get = (key: string) => valueOf(kv, key);
  // The anchors of a /deeds page: the H1 address and the Parcel Details table with its Map Registry # row.
  const details = findSection(page, "Parcel Details")?.tables[0];
  if (pageTitle(markdown) === null || details === undefined || orNull(valueOf(keyValues(details), "Map Registry #")) === null) {
    throw new UnrecognisedPage("deeds: no H1 address, or no Parcel Details table with a Map Registry #");
  }
  const raw: DeedsData["raw"] = {
    origination_date: get("Origination Date"),
    inactive_date: get("Inactive Date"),
    has_air_rights: get("Has Air Rights"),
    is_condo: get("Is Condo"),
    perimeter_ft: get("Perimeter"),
    area_sqft: get("Area"),
  };
  const documents = findSection(page, "Documents");
  return {
    map_registry: orNull(get("Map Registry #")),
    parcel_address: orNull(get("Parcel Address")),
    parcel_status: orNull(get("Status")),
    origination_date: usDate(raw.origination_date),
    inactive_date: raw.inactive_date?.trim() === PLACEHOLDER_DATE ? null : usDate(raw.inactive_date),
    has_air_rights: yesNo(raw.has_air_rights),
    is_condo: yesNo(raw.is_condo),
    perimeter_ft: measure(raw.perimeter_ft, "ft"),
    area_sqft: measure(raw.area_sqft, "sq ft"),
    active_parcels: activeParcels(markdown),
    documents: {
      count: documents?.count ?? null,
      recent: records(documents, DOCUMENT_COLUMNS).map((r) => ({
        id: cell(r, "ID"),
        date: usDate(cell(r, "Date")),
        type: cell(r, "Type"),
        grantor: cell(r, "Grantor"),
        grantee: cell(r, "Grantee"),
        unit: orNull(cell(r, "Unit #")),
        raw: { date: cell(r, "Date") },
      })),
      // The atlas lists the most recent documents and links each to a watermarked copy (the link is
      // not in the markdown); it offers no link to the full list.
      all_url: null,
    },
    raw,
  };
}

/** The section's data, or null when the text is not a /deeds page (no H1 address or Parcel Details table) or the Documents table lacks a column. */
export function parseDeeds(markdown: string): DeedsData | null {
  return orUnrecognised(() => readDeeds(markdown));
}

export const deedsAdapter: SectionAdapter<DeedsData> = {
  id: "deeds",
  label: "Deeds and parcel",
  agency: "Department of Records",
  method: "fetch",
  monitorable: false,
  url: (ctx) => atlasUrl(ctx.address, "deeds"),
  parse: parseDeeds,
};
