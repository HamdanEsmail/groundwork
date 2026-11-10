// Section adapters and the data each section stores (spec 4.2). Dates are ISO (YYYY-MM-DD); every
// parsed number and date keeps the city's string in `raw`. Nothing is inferred: a value the page
// does not give, or gives in a form we cannot read, is null.

export type SectionId =
  | "property"
  | "zoning"
  | "licenses_inspections"
  | "deeds"
  | "assessment_history"
  | "tax"
  | "flood"
  | "schools"
  | "li_deep";

export type SectionStatus = "ok" | "empty" | "unavailable" | "pending" | "error" | "skipped";

/** How much of a list the section holds: the atlas's recent rows, a deep read that fell short of the count, or every row. */
export type Depth = "recent" | "extended" | "full";

export type EventKind =
  | "new_permit"
  | "new_violation"
  | "violation_closed"
  | "new_inspection"
  | "new_appeal"
  | "certification_expired"
  | "assessment_change"
  | "sale"
  | "other";

/** `address` is the resolved uppercase street ("1234 MARKET ST"); `opa` the 9-digit OPA account. */
export interface SectionContext {
  address: string;
  opa: string;
}

/** One change found by `diff`: the rows that changed and each row before and after (null for a new row). */
export interface SectionEvent {
  kind: EventKind;
  summary: string;
  rows: unknown[];
  before: unknown;
  after: unknown;
}

/** `certification_expired` needs both: the time of this read and of the read it is compared with. */
export interface DiffOptions {
  now?: string;
  previousReadAt?: string;
}

export interface SectionAdapter<D extends SectionData = SectionData> {
  id: SectionId;
  label: string;
  agency: string;
  method: "fetch" | "agent";
  monitorable: boolean;
  /** The Monitor purpose (spec 4.5), on monitorable sections. */
  purpose?: string;
  url(ctx: SectionContext): string;
  /** The link a person uses by hand; `url(ctx)` when absent (C3). */
  manualUrl?(ctx: SectionContext): string;
  /**
   * The section's data from an atlas page, or null when the text is not a recognisable read of this
   * tab (a shell served before the page rendered, another tab's page, a missing anchor or column).
   * Callers never store or diff null: the dossier build stores the section as `error` with reason
   * `unrecognized_page`, and a Monitor payload that parses to null is ignored like an incomplete one.
   */
  parse?(markdown: string): D | null;
  goal?(ctx: SectionContext): string;
  outputSchema?: object;
  /** A step limit below the common one, for a page known to answer quickly or not at all. */
  maxSteps?: number;
  /** An Agent run's result as section data; null when it holds none (Task 7). */
  parseResult?(result: unknown): D | null;
  /** Classifies readable Agent data without treating a blocked page as a successful read. */
  classifyResult?(data: D): { status: "ok" | "empty" | "unavailable"; reason?: string };
  /** Both reads are recognised ones: `parse` returned data for each, never null. */
  diff?(before: D, after: D, opts?: DiffOptions): SectionEvent[];
}

/** What a section read produced. `reason` explains `unavailable` and `error`. */
export interface SectionResult {
  status: SectionStatus;
  data: SectionData | null;
  reason: string | null;
}

// --- property (atlas /property) ---------------------------------------------------------------

export interface PropertyData {
  opa_account: string | null;
  opa_address: string | null;
  /** One entry per owner; the cell separates them with runs of two or more spaces. */
  owners: string[];
  /** The mailing address lines, split the same way. */
  mailing_address: string[];
  building_description: string | null;
  year_built: number | null;
  improvement_area_sqft: number | null;
  assessed_value_usd: number | null;
  /** false for "does not have the homestead exemption", true for "has the homestead exemption", else null. */
  homestead: boolean | null;
  sale_date: string | null;
  sale_price_usd: number | null;
  /** N from "There are N condominium units at this address"; null when the page does not say it. */
  units_notice: number | null;
  raw: {
    owners: string | null;
    mailing_address: string | null;
    year_built: string | null;
    improvement_area_sqft: string | null;
    /** Without the "View tax balance & pay bill" link text. */
    assessed_value_usd: string | null;
    /** Without the "Learn about property tax programs" link text. */
    homestead: string | null;
    sale_date: string | null;
    sale_price_usd: string | null;
  };
}

// --- licenses_inspections (atlas /li) ---------------------------------------------------------

/** A list the atlas shows as "## Name (N)" with its most recent rows. `count` is N; null when the header has no count. */
export interface RowList<T> {
  count: number | null;
  recent: T[];
}

export interface Building {
  building_id: string | null;
  name: string | null;
  parcel_address: string | null;
  height_ft: number | null;
  footprint_sqft: number | null;
  raw: { height_ft: string | null; footprint_sqft: string | null };
}

export interface CertificationRow {
  type: string;
  date_inspected: string | null;
  result: string;
  expiration_date: string | null;
  raw: { date_inspected: string; expiration_date: string };
}

/** A permit, inspection or violation row: Date | ID | Description | Status. */
export interface RecordRow {
  date: string | null;
  id: string;
  description: string;
  status: string;
  raw: { date: string };
}

export interface ZoningDocumentRow {
  date: string | null;
  permit_number: string;
  pages: number | null;
  id: string;
  raw: { date: string; pages: string };
}

export interface AppealRow {
  date: string | null;
  id: string;
  grounds: string;
  type: string;
  status: string;
  raw: { date: string };
}

export interface BusinessLicenseRow {
  date: string | null;
  license_number: string;
  name: string;
  type: string;
  status: string;
  raw: { date: string };
}

export interface LicensesInspectionsData {
  /** The selected building's table (the atlas shows one building at a time). */
  buildings: Building[];
  /** N from "There are N buildings at this address"; 1 when the sentence is absent but a building table is shown; null when neither. */
  buildings_count: number | null;
  certifications: RowList<CertificationRow>;
  permits: RowList<RecordRow> & {
    /** L&I Property History for the page's H1 street. */
    all_url: string;
    /** "recent" as the atlas page gives it; the deep read (Task 7) says "extended" or "full". */
    depth: Depth;
  };
  zoning_documents: RowList<ZoningDocumentRow>;
  inspections: RowList<RecordRow>;
  /** `open_count` counts the rows in `recent` whose status is OPEN; `open_count_of` is how many rows that was among. */
  violations: RowList<RecordRow> & { open_count: number; open_count_of: number };
  appeals: RowList<AppealRow>;
  business_licenses: RowList<BusinessLicenseRow>;
}

// --- zoning (atlas /zoning) -------------------------------------------------------------------

export interface ZoningData {
  base_district: string | null;
  base_district_name: string | null;
  /** N from "There is/are N active parcel(s) at this address". */
  active_parcels: number | null;
  /** The rows the atlas shows (at most five per list); `counts` holds the header totals. */
  overlays: { name: string; code_section: string }[];
  pending_bills: { bill_type: string; current_zoning: string; bill: string }[];
  legislation: {
    bill: string;
    status: string;
    enacted_date: string | null;
    original_zoning: string;
    proposed_zoning: string;
    raw: { enacted_date: string };
  }[];
  appeals: {
    processed_date: string | null;
    id: string;
    description: string;
    scheduled_date: string | null;
    status: string;
    raw: { processed_date: string; scheduled_date: string };
  }[];
  /** `name` is the bold organisation name, `address` the rest of that cell. */
  rcos: { name: string; address: string | null; meeting_address: string | null; website: string | null }[];
  counts: {
    pending_bills: number | null;
    overlays: number | null;
    legislation: number | null;
    appeals: number | null;
    rcos: number | null;
  };
  /**
   * true when a shown overlay name matches /flood/i; false when every overlay is shown and none
   * matches; null when some are hidden and none of the shown ones matches. Zoning's signal, not
   * a FEMA determination.
   */
  floodplain_overlay: boolean | null;
}

// --- deeds (atlas /deeds) ---------------------------------------------------------------------

export interface DeedDocumentRow {
  id: string;
  date: string | null;
  type: string;
  grantor: string;
  grantee: string;
  unit: string | null;
  raw: { date: string };
}

export interface DeedsData {
  map_registry: string | null;
  parcel_address: string | null;
  parcel_status: string | null;
  origination_date: string | null;
  /** null for the atlas's 12/30/1899 placeholder (kept in raw). */
  inactive_date: string | null;
  has_air_rights: boolean | null;
  is_condo: boolean | null;
  perimeter_ft: number | null;
  area_sqft: number | null;
  active_parcels: number | null;
  /** Recorded from December 1999 forward. `all_url` is null: the atlas page offers no link to the full list. */
  documents: RowList<DeedDocumentRow> & { all_url: string | null };
  raw: {
    origination_date: string | null;
    inactive_date: string | null;
    has_air_rights: string | null;
    is_condo: string | null;
    perimeter_ft: string | null;
    area_sqft: string | null;
  };
}

// --- Agent sections ---------------------------------------------------------------------------

/** Data of an Agent section. Task 7 replaces this with the typed shapes its `parseResult` returns. */
export type AgentSectionData = Record<string, unknown>;

export type SectionData = PropertyData | LicensesInspectionsData | ZoningData | DeedsData | AgentSectionData;

/** The data type stored for each section id. */
export interface SectionDataMap {
  property: PropertyData;
  zoning: ZoningData;
  licenses_inspections: LicensesInspectionsData;
  deeds: DeedsData;
  assessment_history: AgentSectionData;
  tax: AgentSectionData;
  flood: AgentSectionData;
  schools: AgentSectionData;
  li_deep: AgentSectionData;
}
