// Row types for the D1 tables, column for column as in migrations/0001_init.sql: the raw shapes a
// SELECT returns. Nullable columns are `| null`, INTEGER and REAL are `number`, and the columns a
// CHECK constraint fixes carry that union. JSON columns are the stored text (`string | null`) in the
// `...Row` types; the repositories parse them, and the `Dossier`, `StoredSection` and `StoredEvent`
// types below are what they return. tests/db.test.ts fails if a Row type and its table drift apart.
import type { Units } from "../address/resolve";
import type { SpendKind } from "../core/spend";
import type { Depth, EventKind, SectionData, SectionStatus } from "../sections/types";

export type Tier = "free" | "standard" | "deep";
export type DossierStatus = "partial" | "complete" | "failed";
export type Resolution = "exact" | "fuzzy" | "parent";
export type ResolveOutcome = "resolved" | "ambiguous" | "no_match";
export type AddedBy = "public" | "admin" | "curated";
export type WatchKind = "li" | "property";
/** The statuses the code writes; the schema has no CHECK on `watches.status`. Only `active` holds a Monitor. */
export type WatchStatus = "active" | "expired" | "removed" | "failed";

export interface DossierRow {
  id: string;
  address_input: string | null;
  address_resolved: string | null;
  opa_account: string | null;
  unit: string | null;
  resolution: Resolution | null;
  outcome: ResolveOutcome | null;
  tier: Tier | null;
  status: DossierStatus | null;
  cached_from: string | null;
  ip_hash: string | null;
  added_by: AddedBy | null;
  created_at: string | null;
  completed_at: string | null;
  spend_usd: number | null;
  expires_at: string | null;
  workflow_id: string | null;
  workflow_started_at: string | null;
  callback_url: string | null;
  /** JSON `Units`. */
  units: string | null;
  /** JSON `ResolutionDetail`. */
  resolution_detail: string | null;
}

export interface SectionRow {
  dossier_id: string;
  section_id: string;
  status: SectionStatus | null;
  method: "fetch" | "agent" | null;
  source_url: string | null;
  checked_at: string | null;
  evidence_key: string | null;
  /** JSON `SectionData`. */
  data: string | null;
  raw_key: string | null;
  run_id: string | null;
  error: string | null;
  spend_usd: number | null;
  rows_returned: number | null;
  depth: Depth | null;
}

export interface ParcelRow {
  li_checked_at: string | null;
  opa_account: string;
  address_resolved: string | null;
  /** JSON object keyed by section id. */
  last_section_data: string | null;
  updated_at: string | null;
}

export interface WatchRow {
  owner_hash: string | null;
  id: string;
  opa_account: string | null;
  kind: WatchKind | null;
  monitor_id: string | null;
  added_by: AddedBy | null;
  callback_url: string | null;
  expires_at: string | null;
  status: WatchStatus | null;
  created_at: string | null;
  last_applied_at: string | null;
}

export interface EventRow {
  id: string;
  opa_account: string | null;
  kind: EventKind | null;
  summary: string | null;
  /** JSON array. */
  rows: string | null;
  /** JSON. */
  before: string | null;
  /** JSON. */
  after: string | null;
  source_url: string | null;
  monitor_run_id: string | null;
  at: string | null;
  notified_at: string | null;
}

export interface SpendRow {
  id: string;
  kind: SpendKind | null;
  amount_usd: number | null;
  ref: string | null;
  at: string | null;
}

/** Per-visitor daily counters for the public rate limits. */
export interface PublicUseRow {
  ip_hash: string;
  day: string;
  dossiers: number;
  watches: number;
  upgrades: number;
}

/** The single in-flight Agent run slot (always one row, id 1). Read and written only by src/db/inflight.ts. */
export interface AgentInflightRow {
  id: 1;
  run_id: string | null;
  started_at: string | null;
}

// What the repositories return, with the JSON columns parsed.

/** What a no_match or ambiguous resolution (or a fuzzy one) leaves for the report (C15). */
export interface ResolutionDetail {
  variants_tried?: string[];
  candidates?: { address: string; url: string }[];
  manual_url?: string;
  resolved_to?: string;
  how_to_resolve?: string;
}

/** The columns `insertDossier` always writes (it requires or defaults each), so a row it made never has NULL in them. */
type DossierAlwaysWritten = "id" | "tier" | "status" | "added_by" | "created_at" | "spend_usd";

export type Dossier = Omit<DossierRow, "units" | "resolution_detail" | DossierAlwaysWritten> & {
  id: string;
  tier: Tier;
  status: DossierStatus;
  added_by: AddedBy;
  created_at: string;
  spend_usd: number;
  units: Units | null;
  resolution_detail: ResolutionDetail | null;
};

/** `status` is always written: `upsertSection` starts a new row as `pending` when it is given none. */
export type StoredSection = Omit<SectionRow, "data" | "status"> & { status: SectionStatus; data: SectionData | null };

export type StoredEvent = Omit<EventRow, "rows" | "before" | "after"> & {
  rows: unknown[];
  before: unknown;
  after: unknown;
};
