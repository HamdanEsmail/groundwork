// Zoning: atlas /zoning (Department of Planning and Development). Not watched (spec 6: optional).
import { atlasUrl } from "../tinyfish/fetch";
import {
  UnrecognisedPage,
  activeParcels,
  cell,
  findSection,
  orNull,
  orUnrecognised,
  pageTitle,
  records,
  splitSections,
  usDate,
  type MdPage,
} from "./markdown";
import type { SectionAdapter, ZoningData } from "./types";

/** "**Base District**", then "**CMX-5**", then the district's name on the next line. */
function baseDistrict(page: MdPage): { code: string | null; name: string | null } {
  const lines = page.preamble.text;
  const at = lines.findIndex((l) => /^\*\*Base Districts?\*\*$/i.test(l));
  if (at < 0) return { code: null, name: null };
  const code = /^\*\*(.+)\*\*$/.exec(lines[at + 1] ?? "")?.[1]?.trim() ?? null;
  const next = lines[at + 2];
  const name = code !== null && next !== undefined && !next.startsWith("**") && !/^See more info/i.test(next) ? next : null;
  return { code, name };
}

/** The first cell of an RCO row: the bold organisation name, then its address. */
function rcoName(raw: string): { name: string; address: string | null } {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(raw);
  return m === null ? { name: raw, address: null } : { name: m[1]!.trim(), address: orNull(m[2]) };
}

// The columns each list needs; a table without one of them is not a read of the page.
const OVERLAY_COLUMNS = ["Name", "Code Section"];
const BILL_COLUMNS = ["Bill Type", "Current Zoning", "Pending Bill"];
const LEGISLATION_COLUMNS = ["Bill", "Status", "Enacted date", "Original zoning", "Proposed zoning"];
const APPEAL_COLUMNS = ["Processed Date", "Id", "Description & Coordinating RCO", "Scheduled Date", "Status"];
const RCO_COLUMNS = ["RCO", "Meeting Address", "Primary Contact", "RCO Website"];

function readZoning(markdown: string): ZoningData {
  const page = splitSections(markdown);
  const section = (title: string) => findSection(page, title);
  const rows = (title: string, columns: readonly string[]) => records(section(title), columns);
  const { code, name } = baseDistrict(page);
  // The anchors of a /zoning page: the H1 address and the Base District block.
  if (pageTitle(markdown) === null || code === null) throw new UnrecognisedPage("zoning: no H1 address or Base District block");

  const overlays = rows("Overlays", OVERLAY_COLUMNS).map((r) => ({ name: cell(r, "Name"), code_section: cell(r, "Code Section") }));
  const counts = {
    pending_bills: section("Pending Bills")?.count ?? null,
    overlays: section("Overlays")?.count ?? null,
    legislation: section("Record of Zoning Legislation")?.count ?? null,
    appeals: section("Zoning Appeals")?.count ?? null,
    rcos: section("Registered Community Organizations (RCOs)")?.count ?? null,
  };
  const floodShown = overlays.some((o) => /flood/i.test(o.name));
  const allShown = counts.overlays !== null && overlays.length >= counts.overlays;

  return {
    base_district: code,
    base_district_name: name,
    active_parcels: activeParcels(markdown),
    overlays,
    pending_bills: rows("Pending Bills", BILL_COLUMNS).map((r) => ({
      bill_type: cell(r, "Bill Type"),
      current_zoning: cell(r, "Current Zoning"),
      bill: cell(r, "Pending Bill"),
    })),
    legislation: rows("Record of Zoning Legislation", LEGISLATION_COLUMNS).map((r) => ({
      bill: cell(r, "Bill"),
      status: cell(r, "Status"),
      enacted_date: usDate(cell(r, "Enacted date")),
      original_zoning: cell(r, "Original zoning"),
      proposed_zoning: cell(r, "Proposed zoning"),
      raw: { enacted_date: cell(r, "Enacted date") },
    })),
    appeals: rows("Zoning Appeals", APPEAL_COLUMNS).map((r) => ({
      processed_date: usDate(cell(r, "Processed Date")),
      id: cell(r, "Id"),
      description: cell(r, "Description & Coordinating RCO"),
      scheduled_date: usDate(cell(r, "Scheduled Date")),
      status: cell(r, "Status"),
      raw: { processed_date: cell(r, "Processed Date"), scheduled_date: cell(r, "Scheduled Date") },
    })),
    // The page also names each organization's contact person, with a phone number and an email. That
    // cell is not kept: the person is no part of the property's record.
    rcos: rows("Registered Community Organizations (RCOs)", RCO_COLUMNS).map((r) => ({
      ...rcoName(cell(r, "RCO")),
      meeting_address: orNull(cell(r, "Meeting Address")),
      website: orNull(cell(r, "RCO Website")),
    })),
    counts,
    floodplain_overlay: floodShown ? true : allShown ? false : null,
  };
}

/** The section's data, or null when the text is not a /zoning page (no H1 address or Base District block) or a list lacks a column. */
export function parseZoning(markdown: string): ZoningData | null {
  return orUnrecognised(() => readZoning(markdown));
}

export const zoningAdapter: SectionAdapter<ZoningData> = {
  id: "zoning",
  label: "Zoning",
  agency: "Department of Planning and Development",
  method: "fetch",
  monitorable: false,
  url: (ctx) => atlasUrl(ctx.address, "zoning"),
  parse: parseZoning,
};
