// Live figures for the inner screens. Events and watches on public pages are
// only those of curated parcels and parcels we watch ourselves; a visitor's own
// watch is shown to that visitor alone.
import { PUBLIC_WATCH_SLOTS } from "../core/limits";
import { PUBLIC_OPAS_SQL } from "../db/dossiers";
import { countPublicWatches, listWatches } from "../db/watches";
import type { SpendKind } from "../core/spend";
import type { EventKind } from "../sections/types";
import { day, stamp } from "./format";

export const SHEET_FOR_KIND: Record<EventKind, string> = {
  new_permit: "Licences and inspections",
  new_violation: "Licences and inspections",
  violation_closed: "Licences and inspections",
  new_inspection: "Licences and inspections",
  new_appeal: "Licences and inspections",
  certification_expired: "Licences and inspections",
  assessment_change: "Assessment and sale",
  sale: "Assessment and sale",
  other: "Assessment and sale",
};

const WATCH_SHEET: Record<string, string> = {
  property: "Assessment and sale",
  li: "Licences and inspections",
};

export interface PublicEvent {
  at: string;
  address: string;
  summary: string;
  sheet: string;
}

export function street(address: string | null | undefined): string {
  if (!address) return "";
  const comma = address.indexOf(",");
  return (comma === -1 ? address : address.slice(0, comma)).trim();
}

/**
 * Latest events of the public parcels, newest first. With `ownerHash`, the events of that visitor's own
 * watched parcels are included; they are shown to that visitor and to no one else.
 */
export async function publicEvents(db: D1Database, limit: number, ownerHash: string | null = null): Promise<PublicEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT e.at AS at, e.kind AS kind, e.summary AS summary,
              COALESCE(p.address_resolved, (
                SELECT d.address_resolved FROM dossiers d
                WHERE d.opa_account = e.opa_account AND d.added_by = 'curated'
                ORDER BY d.created_at DESC LIMIT 1
              )) AS address
       FROM events e
       LEFT JOIN parcels p ON p.opa_account = e.opa_account
       WHERE e.opa_account IS NOT NULL AND (
         e.opa_account IN (${PUBLIC_OPAS_SQL})
         OR e.opa_account IN (
           SELECT opa_account FROM watches
           WHERE status = 'active' AND added_by = 'public' AND owner_hash = ?1 AND opa_account IS NOT NULL
         )
       )
       ORDER BY e.at DESC, e.rowid DESC
       LIMIT ?2`,
    )
    .bind(ownerHash, limit)
    .all<{ at: string | null; kind: EventKind | null; summary: string | null; address: string | null }>();
  return results.map((r) => ({
    at: r.at ? day(r.at) : "not stated",
    address: street(r.address) || "not stated",
    summary: r.summary ?? "",
    sheet: SHEET_FOR_KIND[r.kind ?? "other"] ?? "Assessment and sale",
  }));
}

export interface WatchAddress {
  address: string;
  href: string | null;
  sheets: string;
  lastCheck: string;
  lastChange: string;
  ends: string | null;
}

export interface WatchlistData {
  active: number;
  publicSlots: string;
  checks: number;
  changes: number;
  rows: WatchAddress[];
  events: PublicEvent[];
}

function later(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Active watches grouped by parcel, with last check and last change. The watches set with the admin token
 * are listed for everyone; a watch a visitor started is listed for that visitor (`ownerHash`) only, with
 * the day it ends.
 */
export async function watchlistData(db: D1Database, ownerHash: string | null = null): Promise<WatchlistData> {
  const watches = await listWatches(db, { status: "active" });
  const mine = (w: (typeof watches)[number]) => w.added_by === "public" && ownerHash !== null && w.owner_hash === ownerHash;
  const byOpa = new Map<string, typeof watches>();
  for (const w of watches) {
    if (!w.opa_account) continue;
    if (w.added_by !== "admin" && w.added_by !== "curated" && !mine(w)) continue;
    const list = byOpa.get(w.opa_account) ?? [];
    list.push(w);
    byOpa.set(w.opa_account, list);
  }
  const rows: WatchAddress[] = [];
  for (const [opa, group] of byOpa) {
    const parcel = await db
      .prepare("SELECT address_resolved, updated_at, li_checked_at FROM parcels WHERE opa_account = ?")
      .bind(opa)
      .first<{ address_resolved: string | null; updated_at: string | null; li_checked_at: string | null }>();
    const own = group.every(mine);
    // The link goes to a dossier we added, or to the visitor's own; never to another visitor's.
    const dossier = await db
      .prepare(
        `SELECT id, address_resolved FROM dossiers
         WHERE opa_account = ?1 AND (added_by IN ('curated', 'admin') OR (?2 = 1 AND ip_hash = ?3))
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(opa, own ? 1 : 0, ownerHash)
      .first<{ id: string; address_resolved: string | null }>();
    const event = await db
      .prepare("SELECT at FROM events WHERE opa_account = ? ORDER BY at DESC, rowid DESC LIMIT 1")
      .bind(opa)
      .first<{ at: string | null }>();
    const monitors = group.map((w) => w.monitor_id).filter((id): id is string => id != null && id !== "");
    let checkAt: string | null = null;
    for (const w of group) checkAt = later(checkAt, w.last_applied_at);
    checkAt = later(checkAt, parcel?.updated_at);
    checkAt = later(checkAt, parcel?.li_checked_at);
    if (monitors.length) {
      const likes = monitors.map(() => "s.ref LIKE ?").join(" OR ");
      const spend = await db
        .prepare(`SELECT MAX(s.at) AS at FROM spend s WHERE s.kind = 'monitor_check' AND (${likes})`)
        .bind(...monitors.map((id) => `monitor:${id}:%`))
        .first<{ at: string | null }>();
      checkAt = later(checkAt, spend?.at);
    }
    const kinds = [...new Set(group.map((w) => w.kind).filter((k): k is "li" | "property" => k === "li" || k === "property"))];
    kinds.sort((a, b) => (a === "property" ? -1 : b === "property" ? 1 : 0));
    const ownEnd = group.find((w) => mine(w) && w.expires_at)?.expires_at ?? null;
    const resolved = parcel?.address_resolved ?? dossier?.address_resolved ?? opa;
    rows.push({
      address: street(resolved) || resolved,
      href: dossier ? `/d/${dossier.id}` : null,
      sheets: kinds.map((k) => WATCH_SHEET[k] ?? k).join(", "),
      lastCheck: checkAt ? stamp(checkAt) : "not yet",
      // A watched address with no change yet says so; "not stated" is for a field a page leaves out.
      lastChange: event?.at ? day(event.at) : "none yet",
      ends: own ? (ownEnd ? `Yours until ${day(ownEnd)}` : "Yours") : null,
    });
  }
  rows.sort((a, b) => a.address.localeCompare(b.address));
  const publicInUse = await countPublicWatches(db);
  const checks = (await db.prepare("SELECT COUNT(*) AS n FROM spend WHERE kind = 'monitor_check'").first<{ n: number }>())?.n ?? 0;
  const changes =
    (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM events WHERE opa_account IN (${PUBLIC_OPAS_SQL}) OR opa_account IN (
           SELECT opa_account FROM watches
           WHERE status = 'active' AND added_by = 'public' AND owner_hash = ?1 AND opa_account IS NOT NULL
         )`,
      )
      .bind(ownerHash)
      .first<{ n: number }>())?.n ?? 0;
  return {
    active: watches.filter((w) => w.opa_account).length,
    publicSlots: `${publicInUse} of ${PUBLIC_WATCH_SLOTS}`,
    checks,
    changes,
    rows,
    events: await publicEvents(db, 50, ownerHash),
  };
}

/** Last successful read per section, same query as GET /api/sources. */
export async function lastSuccessBySection(db: D1Database): Promise<Map<string, string | null>> {
  const { results } = await db
    .prepare(
      "SELECT section_id, MAX(checked_at) AS last_success_at FROM sections WHERE status IN ('ok','empty') GROUP BY section_id",
    )
    .all<{ section_id: string; last_success_at: string | null }>();
  return new Map(results.map((r) => [r.section_id, r.last_success_at]));
}

export interface ToolSpend {
  name: string;
  does: string;
  calls: number;
  amount: number;
}

/** Calls and US dollars from the spend ledger, mapped onto Fetch, Agent, Browser and Monitor. */
export async function toolSpend(db: D1Database): Promise<ToolSpend[]> {
  const { results } = await db
    .prepare("SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS total FROM spend GROUP BY kind")
    .all<{ kind: string; n: number; total: number }>();
  const byKind = Object.fromEntries(results.map((r) => [r.kind, r])) as Record<string, { n: number; total: number }>;
  const row = (kind: SpendKind) => byKind[kind] ?? { n: 0, total: 0 };
  return [
    {
      name: "Fetch",
      does: "Reads the four atlas pages of a dossier at no cost.",
      calls: row("fetch").n,
      amount: row("fetch").total,
    },
    {
      name: "Agent",
      does: "Opens the five sources that have no simple page, each run capped.",
      calls: row("agent_step").n,
      amount: row("agent_step").total,
    },
    {
      name: "Browser",
      does: "Captures each city page as it was read.",
      calls: row("screenshot").n,
      amount: row("screenshot").total,
    },
    {
      name: "Monitor",
      does: "Reads the licences page and the assessment page of a watched address twice a day.",
      calls: row("monitor_check").n,
      amount: row("monitor_check").total,
    },
  ];
}
