// Licences and inspections: atlas /li (Department of Licenses & Inspections). Monitorable.
import { atlasUrl } from "../tinyfish/fetch";
import {
  UnrecognisedPage,
  cell,
  displayDate,
  findSection,
  measure,
  orNull,
  orUnrecognised,
  pageKeyValues,
  pageTitle,
  records,
  splitSections,
  usDate,
  valueOf,
  wholeNumber,
  type MdPage,
} from "./markdown";
import type {
  AppealRow,
  Building,
  BusinessLicenseRow,
  CertificationRow,
  DiffOptions,
  LicensesInspectionsData,
  RecordRow,
  RowList,
  SectionAdapter,
  SectionEvent,
  ZoningDocumentRow,
} from "./types";

// The columns each list needs; a table without one of them is not a read of the page.
const RECORD_COLUMNS = ["Date", "ID", "Description", "Status"];
const CERTIFICATION_COLUMNS = ["Inspection Type", "Date Inspected", "Inspection Result", "Expiration Date"];
const ZONING_DOCUMENT_COLUMNS = ["Date", "Permit Number", "# Pages", "ID"];
const APPEAL_COLUMNS = ["Date", "Appeal Number", "Appeal Grounds", "Type", "Status"];
const LICENSE_COLUMNS = ["Date", "License Number", "Name", "Type", "Status"];

function list<T>(page: MdPage, title: string, columns: readonly string[], row: (rec: Record<string, string>) => T): RowList<T> {
  const section = findSection(page, title);
  return { count: section?.count ?? null, recent: records(section, columns).map(row) };
}

const recordRow = (rec: Record<string, string>): RecordRow => ({
  date: usDate(cell(rec, "Date")),
  id: cell(rec, "ID"),
  description: cell(rec, "Description"),
  status: cell(rec, "Status"),
  raw: { date: cell(rec, "Date") },
});

const certificationRow = (rec: Record<string, string>): CertificationRow => ({
  type: cell(rec, "Inspection Type"),
  date_inspected: usDate(cell(rec, "Date Inspected")),
  result: cell(rec, "Inspection Result"),
  expiration_date: usDate(cell(rec, "Expiration Date")),
  raw: { date_inspected: cell(rec, "Date Inspected"), expiration_date: cell(rec, "Expiration Date") },
});

const zoningDocumentRow = (rec: Record<string, string>): ZoningDocumentRow => ({
  date: usDate(cell(rec, "Date")),
  permit_number: cell(rec, "Permit Number"),
  pages: wholeNumber(cell(rec, "# Pages")),
  id: cell(rec, "ID"),
  raw: { date: cell(rec, "Date"), pages: cell(rec, "# Pages") },
});

const appealRow = (rec: Record<string, string>): AppealRow => ({
  date: usDate(cell(rec, "Date")),
  id: cell(rec, "Appeal Number"),
  grounds: cell(rec, "Appeal Grounds"),
  type: cell(rec, "Type"),
  status: cell(rec, "Status"),
  raw: { date: cell(rec, "Date") },
});

const businessLicenseRow = (rec: Record<string, string>): BusinessLicenseRow => ({
  date: usDate(cell(rec, "Date")),
  license_number: cell(rec, "License Number"),
  name: cell(rec, "Name"),
  type: cell(rec, "Type"),
  status: cell(rec, "Status"),
  raw: { date: cell(rec, "Date") },
});

/** The selected building's table (Building ID, Building Name, ...), if the page shows one. */
function building(page: MdPage): Building | null {
  const kv = pageKeyValues(page);
  if (valueOf(kv, "Building ID") === null) return null;
  const height = valueOf(kv, "Building Height (approx)");
  const footprint = valueOf(kv, "Building Footprint (approx)");
  return {
    building_id: orNull(valueOf(kv, "Building ID")),
    name: orNull(valueOf(kv, "Building Name")),
    parcel_address: orNull(valueOf(kv, "Parcel Address")),
    height_ft: measure(height, "ft"),
    footprint_sqft: measure(footprint, "sq ft"),
    raw: { height_ft: height, footprint_sqft: footprint },
  };
}

function readLi(markdown: string): LicensesInspectionsData {
  const page = splitSections(markdown);
  const selected = building(page);
  // The anchors of an /li page: counted Permits and Violations headers (a count of 0 is a count) and
  // the address. The atlas sometimes serves this tab without its H1 (2314 Brown St, 12 November
  // 2026); the selected building's parcel address then says which address the page is for. The
  // other lists may be missing: a property without inspections has no such header.
  const street = pageTitle(markdown) ?? selected?.parcel_address ?? null;
  if (street === null || findSection(page, "Permits")?.count == null || findSection(page, "Violations")?.count == null) {
    throw new UnrecognisedPage("li: no address, or no counted Permits and Violations headers");
  }
  const sentence = /There (?:is|are) (\d+) buildings? at this address/i.exec(markdown);
  const violations = list(page, "Violations", RECORD_COLUMNS, recordRow);
  return {
    buildings: selected === null ? [] : [selected],
    buildings_count: sentence !== null ? Number(sentence[1]) : selected !== null ? 1 : null,
    certifications: list(page, "Building Certifications", CERTIFICATION_COLUMNS, certificationRow),
    permits: {
      ...list(page, "Permits", RECORD_COLUMNS, recordRow),
      // The markdown drops the page's "See all permits" link; L&I Property History takes the H1 street.
      all_url: `https://li.phila.gov/property-history/search?address=${encodeURIComponent(street)}`,
      depth: "recent",
    },
    zoning_documents: list(page, "Zoning Permit Documents", ZONING_DOCUMENT_COLUMNS, zoningDocumentRow),
    inspections: list(page, "Inspections", RECORD_COLUMNS, recordRow),
    violations: {
      ...violations,
      open_count: violations.recent.filter((r) => r.status.toUpperCase() === "OPEN").length,
      open_count_of: violations.recent.length,
    },
    appeals: list(page, "L&I Appeals", APPEAL_COLUMNS, appealRow),
    business_licenses: list(page, "Business Licenses", LICENSE_COLUMNS, businessLicenseRow),
  };
}

/**
 * The section's data, or null when the text is not a recognisable /li page: no H1 address, no
 * counted Permits and Violations headers (a Loading page, a shell), or a list whose table lacks a
 * column it needs.
 */
export function parseLi(markdown: string): LicensesInspectionsData | null {
  return orUnrecognised(() => readLi(markdown));
}

// --- diff -----------------------------------------------------------------------------------

const CLOSED_STATUSES = new Set(["CLOSED", "COMPLIED"]);
const key = (...parts: unknown[]) => JSON.stringify(parts);

/**
 * Rows of `after` that `before` did not have, by identity. The atlas shows only the most recent
 * rows of each list. When `before` showed fewer rows than its count (or gave no count), a row dated
 * before the oldest dated row it showed was hidden by that window, not added; a row with that very
 * date is new only when the list's count went up (the window may just be showing another row of the
 * same day, as at the edge of the Inspections list); a newer row or one with no date is new. When
 * `before` showed every row, nothing was hidden and any row it lacked is new, even a backdated one.
 * Removed rows and order are ignored.
 */
function addedRows<T>(before: RowList<T>, after: RowList<T>, id: (r: T) => string, date: (r: T) => string | null): T[] {
  const known = new Set(before.recent.map(id));
  const dates = before.recent.map(date).filter((d): d is string => d !== null);
  const oldest = dates.length > 0 ? dates.reduce((x, y) => (y < x ? y : x)) : null;
  const truncated = before.count === null || before.count > before.recent.length;
  const grew = before.count !== null && after.count !== null && after.count > before.count;
  const added: T[] = [];
  for (const row of after.recent) {
    const k = id(row);
    if (known.has(k)) continue;
    known.add(k);
    const d = date(row);
    if (truncated && oldest !== null && d !== null && (d < oldest || (d === oldest && !grew))) continue;
    added.push(row);
  }
  return added;
}

const dated = (row: { date: string | null }, word: string) => (row.date === null ? "" : ` ${word} ${displayDate(row.date)}`);
/** A date the city gave in another form ("To Be Determined") is kept, after the sentence, as the city wrote it. */
const undated = (row: { date: string | null; raw: { date: string } }) => (row.date === null && row.raw.date !== "" ? `; date ${row.raw.date}` : "");

/** The newest certification of each type in `after` whose expiration date falls in (previousReadAt, now]. */
function expiredCertifications(before: LicensesInspectionsData, after: LicensesInspectionsData, opts: DiffOptions): SectionEvent[] {
  if (opts.now === undefined || opts.previousReadAt === undefined) return [];
  const from = Date.parse(opts.previousReadAt);
  const to = Date.parse(opts.now);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];

  const newest = new Map<string, CertificationRow>();
  for (const row of after.certifications.recent) {
    if (row.date_inspected === null) continue;
    const seen = newest.get(row.type);
    if (seen === undefined || row.date_inspected > seen.date_inspected!) newest.set(row.type, row);
  }
  const certKey = (r: CertificationRow) => key(r.type, r.date_inspected);
  const events: SectionEvent[] = [];
  for (const row of after.certifications.recent) {
    if (newest.get(row.type) !== row || row.expiration_date === null) continue;
    // An expiration date is taken as the start of that day, UTC.
    const at = Date.parse(`${row.expiration_date}T00:00:00Z`);
    if (!(from < at && at <= to)) continue;
    const was = before.certifications.recent.find((r) => certKey(r) === certKey(row)) ?? null;
    const inspected = row.date_inspected === null ? "" : `inspected ${displayDate(row.date_inspected)}, `;
    events.push({
      kind: "certification_expired",
      summary: `${row.type} expired ${displayDate(row.expiration_date)} (${inspected}${row.result}).`,
      rows: [row],
      before: was,
      after: row,
    });
  }
  return events;
}

/**
 * Events between two complete /li reads: new permits (by id), inspections (by date, id,
 * description and status: the atlas lists one inspection id once per result), violations (by id
 * and description: one case id carries several violations) and appeals (by id); a violation whose
 * status moves to CLOSED or COMPLIED; with `opts`, certifications that expired between the reads.
 */
export function diffLi(before: LicensesInspectionsData, after: LicensesInspectionsData, opts?: DiffOptions): SectionEvent[] {
  const events: SectionEvent[] = [];
  const added = (kind: SectionEvent["kind"], row: unknown, summary: string) => {
    events.push({ kind, summary, rows: [row], before: null, after: row });
  };

  for (const r of addedRows(before.permits, after.permits, (p) => key(p.id), (p) => p.date)) {
    added("new_permit", r, `New permit ${r.id}${dated(r, "issued")} (${r.description}, ${r.status})${undated(r)}.`);
  }
  const inspectionKey = (r: RecordRow) => key(r.date, r.id, r.description, r.status);
  for (const r of addedRows(before.inspections, after.inspections, inspectionKey, (i) => i.date)) {
    added("new_inspection", r, `New inspection ${r.id}${dated(r, "on")} (${r.description}, ${r.status})${undated(r)}.`);
  }
  const violationKey = (r: RecordRow) => key(r.id, r.description);
  for (const r of addedRows(before.violations, after.violations, violationKey, (v) => v.date)) {
    added("new_violation", r, `New violation ${r.id}${dated(r, "on")} (${r.description}, ${r.status})${undated(r)}.`);
  }
  const previous = new Map<string, RecordRow>();
  for (const r of before.violations.recent) if (!previous.has(violationKey(r))) previous.set(violationKey(r), r);
  const checked = new Set<string>();
  for (const r of after.violations.recent) {
    const k = violationKey(r);
    const was = previous.get(k);
    if (was === undefined || checked.has(k)) continue;
    checked.add(k);
    const status = r.status.toUpperCase();
    if (CLOSED_STATUSES.has(status) && !CLOSED_STATUSES.has(was.status.toUpperCase())) {
      events.push({
        kind: "violation_closed",
        summary: `Violation ${r.id} (${r.description}) ${status.toLowerCase()}.`,
        rows: [r],
        before: was,
        after: r,
      });
    }
  }
  for (const r of addedRows(before.appeals, after.appeals, (a) => key(a.id), (a) => a.date)) {
    added("new_appeal", r, `New appeal ${r.id}${dated(r, "dated")} (${r.type}, ${r.status})${undated(r)}.`);
  }
  if (opts !== undefined) events.push(...expiredCertifications(before, after, opts));
  return events;
}

export const liAdapter: SectionAdapter<LicensesInspectionsData> = {
  id: "licenses_inspections",
  label: "Licences and inspections",
  agency: "Department of Licenses & Inspections",
  method: "fetch",
  monitorable: true,
  purpose:
    "A permit, inspection, violation, appeal or building certification was added or changed status. Ignore timestamps, ordering and layout.",
  url: (ctx) => atlasUrl(ctx.address, "li"),
  parse: parseLi,
  diff: diffLi,
};
