import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_HOURS } from "../src/core/limits";
import {
  copySections,
  expirePublicDossiers,
  findCachedDossier,
  getDossier,
  insertDossier,
  listPublicDossiers,
  listPublicOpas,
  updateDossier,
  type NewDossier,
} from "../src/db/dossiers";
import { insertEvent, listEvents, listEventsForOpa, markNotified, MAX_EVENTS_LIMIT } from "../src/db/events";
import { getParcelSection, upsertParcelSection } from "../src/db/parcels";
import { claimPublicUse, releasePublicUse, today } from "../src/db/publicUse";
import { getSections, pendingAgentSections, setSectionStatus, upsertSection } from "../src/db/sections";
import type {
  AgentInflightRow,
  DossierRow,
  EventRow,
  ParcelRow,
  PublicUseRow,
  SectionRow,
  SpendRow,
  WatchRow,
} from "../src/db/types";
import {
  countMonitors,
  countPublicWatches,
  dueForExpiry,
  getWatch,
  getWatchByMonitorId,
  insertWatch,
  listWatches,
  setWatchStatus,
  type NewWatch,
} from "../src/db/watches";
import { FREE_SECTION_IDS, SECTIONS } from "../src/sections/index";
import { parseLi } from "../src/sections/li";
import { parseProperty } from "../src/sections/property";
import type { SectionId, SectionStatus } from "../src/sections/types";
import { parseZoning } from "../src/sections/zoning";

const db = env.DB;

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fx(name: string): string {
  const text = fixtures[`./fixtures/atlas/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}
function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected the page to be recognised");
  return value;
}

const HOUR = 3_600_000;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const ahead = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

const OPA = "883309050";

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM dossiers"),
    db.prepare("DELETE FROM sections"),
    db.prepare("DELETE FROM parcels"),
    db.prepare("DELETE FROM watches"),
    db.prepare("DELETE FROM events"),
    db.prepare("DELETE FROM public_use"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A finished standard dossier of the 1234 Market St account, built an hour ago for a public caller. */
function dossierRow(over: Partial<NewDossier> = {}): NewDossier {
  return {
    address_input: "1234 market st",
    address_resolved: "1234 MARKET ST",
    opa_account: OPA,
    resolution: "exact",
    outcome: "resolved",
    tier: "standard",
    status: "complete",
    added_by: "public",
    created_at: ago(1),
    ...over,
  };
}
const addDossier = (over: Partial<NewDossier> = {}) => insertDossier(db, dossierRow(over));

/** The four free sections, each with its own evidence object. */
async function addFreeSections(dossierId: string, status: SectionStatus = "ok") {
  for (const sectionId of FREE_SECTION_IDS) {
    await upsertSection(db, dossierId, sectionId, {
      status,
      method: "fetch",
      source_url: `https://atlas.phila.gov/1234%20MARKET%20ST/${sectionId}`,
      checked_at: ago(1),
      evidence_key: `evidence/${dossierId}/${sectionId}.jpg`,
      data: { read: sectionId },
    });
  }
}

async function exists(table: "dossiers" | "sections", dossierId: string): Promise<number> {
  const column = table === "dossiers" ? "id" : "dossier_id";
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(dossierId).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("row types", () => {
  // Each literal must satisfy its row type (tsc fails on a missing or extra key), and its keys must
  // equal the table's columns in migrations/0001_init.sql, so the types cannot drift from the schema.
  const ROWS = {
    dossiers: {
      id: "", address_input: null, address_resolved: null, opa_account: null, unit: null, resolution: null,
      outcome: null, tier: null, status: null, cached_from: null, ip_hash: null, added_by: null, created_at: null,
      completed_at: null, spend_usd: null, expires_at: null, workflow_id: null, workflow_started_at: null,
      callback_url: null, units: null, resolution_detail: null,
    } satisfies DossierRow,
    sections: {
      dossier_id: "", section_id: "", status: null, method: null, source_url: null, checked_at: null,
      evidence_key: null, data: null, raw_key: null, run_id: null, error: null, spend_usd: null,
      rows_returned: null, depth: null,
    } satisfies SectionRow,
    parcels: { opa_account: "", address_resolved: null, last_section_data: null, updated_at: null, li_checked_at: null } satisfies ParcelRow,
    watches: {
      id: "", opa_account: null, kind: null, monitor_id: null, added_by: null, callback_url: null,
      expires_at: null, status: null, created_at: null, owner_hash: null, last_applied_at: null,
    } satisfies WatchRow,
    events: {
      id: "", opa_account: null, kind: null, summary: null, rows: null, before: null, after: null,
      source_url: null, monitor_run_id: null, at: null, notified_at: null,
    } satisfies EventRow,
    spend: { id: "", kind: null, amount_usd: null, ref: null, at: null } satisfies SpendRow,
    public_use: { ip_hash: "", day: "", dossiers: 0, watches: 0, upgrades: 0 } satisfies PublicUseRow,
    agent_inflight: { id: 1, run_id: null, started_at: null } satisfies AgentInflightRow,
  };

  it.each(Object.entries(ROWS))("%s mirrors the table column for column", async (table, row) => {
    const { results } = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
    expect(Object.keys(row).sort()).toEqual(results.map((c) => c.name).sort());
  });
});

describe("dossiers", () => {
  it("inserts a row with a generated id and defaults, and reads it back with the JSON columns parsed", async () => {
    const units = { count: 2, list: [{ address: "1500-42 MARKET ST", opa_account: "883320000" }], list_url: "https://atlas.phila.gov/1500%20Market%20St/condos" };
    const detail = { variants_tried: ["1500 market st", "1500 MARKET ST"], manual_url: "https://atlas.phila.gov/" };
    const before = Date.now();
    const id = await insertDossier(db, { tier: "free", status: "partial", added_by: "admin", units, resolution_detail: detail, ip_hash: "h1" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await getDossier(db, id);
    expect(row).toMatchObject({
      id, tier: "free", status: "partial", added_by: "admin", units, resolution_detail: detail, ip_hash: "h1",
      opa_account: null, cached_from: null, completed_at: null, expires_at: null, spend_usd: 0,
    });
    expect(Date.parse(row!.created_at)).toBeGreaterThanOrEqual(before);
    expect(row!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // The stored text is JSON, not a JS object.
    const raw = await db.prepare("SELECT units, resolution_detail FROM dossiers WHERE id = ?").bind(id).first<{ units: string; resolution_detail: string }>();
    expect(JSON.parse(raw!.units)).toEqual(units);
    expect(JSON.parse(raw!.resolution_detail)).toEqual(detail);
  });

  it("uses the id and created_at it is given, and stores times to the millisecond", async () => {
    const id = await addDossier({ id: "fixed-id", created_at: "2026-11-03T09:22:34Z", expires_at: "2026-11-10T09:22:34Z" });
    expect(id).toBe("fixed-id");
    const row = await getDossier(db, "fixed-id");
    expect(row).toMatchObject({ created_at: "2026-11-03T09:22:34.000Z", expires_at: "2026-11-10T09:22:34.000Z" });
    await expect(addDossier({ created_at: "last tuesday" })).rejects.toThrow(RangeError);
  });

  it("returns null for an unknown id", async () => {
    expect(await getDossier(db, "nope")).toBeNull();
  });

  it("updateDossier changes only the given columns; null clears a column; JSON is stringified", async () => {
    const id = await addDossier({ id: "u1", tier: "free", status: "partial", spend_usd: 0.008, workflow_id: "wf-1" });
    const units = { count: 3, list: null, list_url: "https://atlas.phila.gov/x/condos" };
    expect(
      await updateDossier(db, id, { status: "complete", tier: "standard", completed_at: "2026-11-03T12:30:00Z", spend_usd: 0.904, units, workflow_id: null }),
    ).toBe(true);
    const row = await getDossier(db, id);
    expect(row).toMatchObject({
      status: "complete", tier: "standard", completed_at: "2026-11-03T12:30:00.000Z", spend_usd: 0.904, units, workflow_id: null,
      // untouched
      address_resolved: "1234 MARKET ST", opa_account: OPA, added_by: "public", created_at: ago(1),
    });
  });

  it("updateDossier returns false for an unknown id or an empty patch, and rejects a column that is not patchable", async () => {
    expect(await updateDossier(db, "nope", { status: "failed" })).toBe(false);
    const id = await addDossier({ id: "u2" });
    expect(await updateDossier(db, id, {})).toBe(false);
    for (const bad of ["id", "added_by", "created_at", "ip_hash", "address_input", "cached_from", "bogus"]) {
      await expect(updateDossier(db, id, { [bad]: "x" } as never)).rejects.toThrow(/not patchable/);
    }
    expect(await getDossier(db, id)).toMatchObject({ id: "u2", added_by: "public", ip_hash: null });
  });

  it("insertDossier and updateDossier refuse a null in a column every dossier has", async () => {
    await expect(insertDossier(db, { status: "partial", added_by: "admin" } as never)).rejects.toThrow(/"tier" cannot be null/);
    await expect(insertDossier(db, { tier: "free", status: "partial", added_by: "admin", created_at: null } as never)).rejects.toThrow(/"created_at" cannot be null/);
    const id = await addDossier({ id: "req" });
    await expect(updateDossier(db, id, { status: null } as never)).rejects.toThrow(/"status" cannot be null/);
    await expect(updateDossier(db, id, { tier: null } as never)).rejects.toThrow(/"tier" cannot be null/);
    await expect(updateDossier(db, id, { spend_usd: null } as never)).rejects.toThrow(/"spend_usd" cannot be null/);
    expect(await getDossier(db, id)).toMatchObject({ status: "complete", tier: "standard" });
  });

  describe("findCachedDossier", () => {
    const find = (minTier: "free" | "standard" | "deep" = "free", opa = OPA, withinHours = CACHE_HOURS) =>
      findCachedDossier(db, opa, withinHours, { minTier, now: NOW });

    it("hits a dossier inside the window and misses one outside it; the window edge counts as inside", async () => {
      expect(await find()).toBeNull();
      const old = await addDossier({ id: "old", created_at: ago(CACHE_HOURS + 1) });
      await addFreeSections(old);
      expect(await find()).toBeNull();

      const edge = await addDossier({ id: "edge", created_at: ago(CACHE_HOURS) });
      await addFreeSections(edge);
      expect((await find())?.id).toBe("edge");

      const fresh = await addDossier({ id: "fresh", created_at: ago(2) });
      await addFreeSections(fresh);
      expect((await find())?.id).toBe("fresh");

      // A shorter window drops the two-hour-old one too.
      expect((await find("free", OPA, 1))).toBeNull();
      expect((await find("free", OPA, 3))?.id).toBe("fresh");
    });

    it("returns the parsed row of the most recent qualifying dossier of that OPA account only", async () => {
      const a = await addDossier({ id: "a", created_at: ago(5), units: { count: 2, list: null, list_url: "u" } });
      const b = await addDossier({ id: "b", created_at: ago(3) });
      const other = await addDossier({ id: "other", created_at: ago(1), opa_account: "111111111" });
      for (const id of [a, b, other]) await addFreeSections(id);
      expect(await find()).toMatchObject({ id: "b", opa_account: OPA });
      expect((await find("free", "111111111"))?.id).toBe("other");
      expect(await find("free", "999999999")).toBeNull();
      await db.prepare("DELETE FROM dossiers WHERE id = 'b'").run();
      expect(await find()).toMatchObject({ id: "a", units: { count: 2, list: null, list_url: "u" } });
    });

    it("requires a tier at least minTier (free < standard < deep)", async () => {
      for (const tier of ["free", "standard", "deep"] as const) {
        const id = await addDossier({ id: tier, tier, created_at: ago(tier === "free" ? 1 : tier === "standard" ? 2 : 3) });
        await addFreeSections(id);
      }
      expect((await find("free"))?.id).toBe("free"); // the newest of the three
      expect((await find("standard"))?.id).toBe("standard");
      expect((await find("deep"))?.id).toBe("deep");
      await db.prepare("DELETE FROM dossiers WHERE id = 'deep'").run();
      expect(await find("deep")).toBeNull();
    });

    it("never returns a failed dossier; a partial one (still running) is a hit and a complete one is a hit", async () => {
      const failed = await addDossier({ id: "failed", status: "failed", created_at: ago(1) });
      await addFreeSections(failed);
      expect(await find()).toBeNull();

      const partial = await addDossier({ id: "partial", status: "partial", created_at: ago(2) });
      await addFreeSections(partial);
      await upsertSection(db, partial, "tax", { status: "pending", method: "agent" });
      expect((await find())?.id).toBe("partial"); // the failed, newer one is skipped, not a block

      const complete = await addDossier({ id: "complete", status: "complete", created_at: ago(1) });
      await addFreeSections(complete);
      expect((await find())?.id).toBe("complete");
    });

    it("needs each of the four free sections ok or empty: a missing, error, unavailable or pending one is no hit", async () => {
      for (const bad of ["error", "unavailable", "pending"] as const) {
        const id = await addDossier({ id: `bad-${bad}` });
        await addFreeSections(id);
        await setSectionStatus(db, id, "deeds", bad, bad === "error" ? "fetch_failed" : undefined);
        expect(await find(), bad).toBeNull();
        await db.prepare("DELETE FROM dossiers WHERE id = ?").bind(id).run();
      }
      const missing = await addDossier({ id: "missing" });
      await addFreeSections(missing);
      await db.prepare("DELETE FROM sections WHERE dossier_id = 'missing' AND section_id = 'zoning'").run();
      expect(await find()).toBeNull();

      // A good dossier hits; an Agent section that is not ok does not matter, only the four free ones count.
      const good = await addDossier({ id: "good" });
      await addFreeSections(good);
      await upsertSection(db, good, "tax", { status: "error", method: "agent", error: "agent_timeout" });
      expect((await find())?.id).toBe("good");
    });

    it("an empty free section is still a cache source (a clean property has an empty licences page); an error one is not", async () => {
      const clean = await addDossier({ id: "clean" });
      await addFreeSections(clean);
      await setSectionStatus(db, clean, "licenses_inspections", "empty");
      expect((await find())?.id).toBe("clean");

      // Every free section empty at once is still a hit; one error among empties is not.
      const allEmpty = await addDossier({ id: "all-empty", created_at: ago(0.5) });
      await addFreeSections(allEmpty, "empty");
      expect((await find())?.id).toBe("all-empty");
      await setSectionStatus(db, allEmpty, "zoning", "error", "unrecognized_page");
      expect((await find())?.id).toBe("clean"); // the newer dossier no longer qualifies; the older clean one does
      await setSectionStatus(db, clean, "licenses_inspections", "error", "incomplete_after_retries");
      expect(await find()).toBeNull();
    });

    it("does not return a cache copy, so a chain of copies cannot keep old data inside the window", async () => {
      const original = await addDossier({ id: "orig", created_at: ago(23) });
      await addFreeSections(original);
      const copy = await addDossier({ id: "copy", created_at: ago(1), cached_from: original });
      await copySections(db, original, copy);
      expect((await find())?.id).toBe("orig");
      await db.prepare("DELETE FROM dossiers WHERE id = 'orig'").run();
      expect(await find()).toBeNull();
    });
  });

  it("copySections copies every section column to the other dossier and shares the evidence keys", async () => {
    const from = await addDossier({ id: "from" });
    const to = await addDossier({ id: "to", cached_from: from });
    await upsertSection(db, from, "property", {
      status: "ok", method: "fetch", source_url: "https://atlas.phila.gov/p", checked_at: ago(1), evidence_key: "evidence/from/property.jpg",
      data: { owners: ["SEPTA"] }, raw_key: "raw/from/property.md", run_id: "run-1", error: null, spend_usd: 0.002, rows_returned: 5, depth: "recent",
    });
    await upsertSection(db, from, "tax", { status: "error", method: "agent", error: "agent_timeout", run_id: "run-2", spend_usd: 0.224 });
    await upsertSection(db, from, "li_deep", { status: "skipped", method: "agent" });
    await upsertSection(db, "someone-else", "property", { status: "ok" });

    expect(await copySections(db, from, to)).toBe(3);

    const raw = async (id: string) =>
      (await db.prepare("SELECT * FROM sections WHERE dossier_id = ? ORDER BY section_id").bind(id).all<Record<string, unknown>>()).results;
    const original = await raw(from);
    const copied = await raw(to);
    expect(copied).toHaveLength(3);
    expect(copied.map((r) => ({ ...r, dossier_id: "x" }))).toEqual(original.map((r) => ({ ...r, dossier_id: "x" })));
    expect(copied.every((r) => r.dossier_id === to)).toBe(true);
    expect(copied.find((r) => r.section_id === "property")).toMatchObject({
      evidence_key: "evidence/from/property.jpg", raw_key: "raw/from/property.md", run_id: "run-1", spend_usd: 0.002, rows_returned: 5, depth: "recent",
    });
    // Nothing else moved: the source keeps its rows, the other dossier is untouched.
    expect(await exists("sections", from)).toBe(3);
    expect(await exists("sections", "someone-else")).toBe(1);
    expect(await copySections(db, "no-such-dossier", to.concat("-2"))).toBe(0);
  });

  describe("listPublicDossiers", () => {
    it("lists curated dossiers and the dossiers we added of an account we watch, newest first, never a visitor's", async () => {
      await addDossier({ id: "curated", added_by: "curated", opa_account: "111111111", created_at: ago(30) });
      await addDossier({ id: "admin-of-curated", added_by: "admin", opa_account: "111111111", created_at: ago(29) });
      await addDossier({ id: "public-of-curated", added_by: "public", opa_account: "111111111", created_at: ago(28) });
      await addDossier({ id: "public-of-ours", added_by: "public", opa_account: "555555555", created_at: ago(4) });
      await addDossier({ id: "admin-plain", added_by: "admin", opa_account: "222222222", created_at: ago(20) });
      await addDossier({ id: "public-plain", added_by: "public", opa_account: "333333333", created_at: ago(10) });
      await addDossier({ id: "public-watched", added_by: "public", opa_account: "444444444", created_at: ago(5) });
      await addDossier({ id: "admin-watched", added_by: "admin", opa_account: "555555555", created_at: ago(2) });
      await addDossier({ id: "public-expired-watch", added_by: "public", opa_account: "666666666", created_at: ago(3) });
      await addDossier({ id: "no-account", added_by: "public", opa_account: null, created_at: ago(1) });
      await insertWatch(db, { opa_account: "444444444", kind: "li", monitor_id: "m1", added_by: "public", expires_at: ahead(100) });
      await insertWatch(db, { opa_account: "555555555", kind: "property", monitor_id: "m2", added_by: "admin" });
      await insertWatch(db, { opa_account: "666666666", kind: "li", monitor_id: "m3", added_by: "public", status: "expired" });
      await insertWatch(db, { opa_account: "222222222", kind: "li", monitor_id: "m4", added_by: "admin", status: "removed" });

      const rows = await listPublicDossiers(db);
      expect(rows.map((r) => r.id)).toEqual(["admin-watched", "admin-of-curated", "curated"]);
      expect([...(await listPublicOpas(db))].sort()).toEqual(["111111111", "555555555"]);
    });
  });

  describe("expirePublicDossiers", () => {
    it("deletes expired public dossiers and their sections, and keeps watched, curated, admin and unexpired ones", async () => {
      const plan: { id: string; over: Partial<NewDossier> }[] = [
        { id: "expired-a", over: { expires_at: ago(1), opa_account: "100000001", created_at: ago(170) } },
        { id: "expired-b", over: { expires_at: NOW_ISO, opa_account: "100000002", created_at: ago(169) } }, // the edge counts
        { id: "not-yet", over: { expires_at: ahead(1), opa_account: "100000003" } },
        { id: "no-expiry", over: { expires_at: null, opa_account: "100000004" } },
        { id: "watched", over: { expires_at: ago(5), opa_account: "100000005" } },
        { id: "expired-watch", over: { expires_at: ago(5), opa_account: "100000006", created_at: ago(168) } },
        { id: "curated", over: { added_by: "curated", expires_at: ago(5), opa_account: "100000007" } },
        { id: "admin", over: { added_by: "admin", expires_at: ago(5), opa_account: "100000008" } },
        { id: "no-opa", over: { expires_at: ago(5), opa_account: null, created_at: ago(167) } },
      ];
      for (const p of plan) {
        const id = await addDossier({ id: p.id, ...p.over });
        await addFreeSections(id);
      }
      await insertWatch(db, { opa_account: "100000005", kind: "li", monitor_id: "m-w", added_by: "public", expires_at: ahead(48) });
      await insertWatch(db, { opa_account: "100000006", kind: "li", monitor_id: "m-e", added_by: "public", status: "expired", expires_at: ago(2) });

      const out = await expirePublicDossiers(db, NOW_ISO);
      expect(out.ids).toEqual(["expired-a", "expired-b", "expired-watch", "no-opa"]); // oldest first
      expect(out.evidenceKeys).toEqual(
        ["expired-a", "expired-b", "expired-watch", "no-opa"].flatMap((id) => FREE_SECTION_IDS.map((s) => `evidence/${id}/${s}.jpg`)).sort(),
      );
      for (const id of out.ids) {
        expect(await exists("dossiers", id)).toBe(0);
        expect(await exists("sections", id)).toBe(0);
      }
      for (const id of ["not-yet", "no-expiry", "watched", "curated", "admin"]) {
        expect(await exists("dossiers", id), id).toBe(1);
        expect(await exists("sections", id), id).toBe(4);
      }
      // A second run finds nothing.
      expect(await expirePublicDossiers(db, NOW_ISO)).toEqual({ ids: [], evidenceKeys: [] });
    });

    it("returns an evidence key only when no remaining section still references it", async () => {
      const original = await addDossier({ id: "orig", expires_at: ago(1), created_at: ago(170) });
      const copy = await addDossier({ id: "copy", cached_from: original, expires_at: ahead(150), created_at: ago(20) });
      const twin = await addDossier({ id: "twin", expires_at: ago(2), created_at: ago(171) });
      await addFreeSections(original);
      await copySections(db, original, copy);
      await upsertSection(db, original, "tax", { status: "ok", method: "agent", evidence_key: "evidence/orig/tax.jpg" });
      // The twin has its own key and one it shares with the original (both are being deleted).
      await upsertSection(db, twin, "property", { status: "ok", evidence_key: "evidence/shared-by-two-expired.jpg" });
      await upsertSection(db, twin, "zoning", { status: "ok", evidence_key: "evidence/twin/zoning.jpg" });
      await upsertSection(db, original, "schools", { status: "ok", method: "agent", evidence_key: "evidence/shared-by-two-expired.jpg" });
      await upsertSection(db, original, "flood", { status: "unavailable", method: "agent", evidence_key: null });

      const out = await expirePublicDossiers(db, NOW_ISO);
      expect(out.ids).toEqual(["twin", "orig"]);
      // The four free keys of "orig" stay: the copy still points at them. Its tax key and the twin's keys go, the
      // key held by two deleted dossiers once.
      expect(out.evidenceKeys).toEqual(["evidence/orig/tax.jpg", "evidence/shared-by-two-expired.jpg", "evidence/twin/zoning.jpg"]);
      expect(await exists("sections", copy)).toBe(4);

      // Once the copy expires too, its keys are unreferenced and are returned.
      const later = await expirePublicDossiers(db, ahead(200));
      expect(later.ids).toEqual(["copy"]);
      expect(later.evidenceKeys).toEqual(FREE_SECTION_IDS.map((s) => `evidence/orig/${s}.jpg`).sort());
    });

    it("does nothing and returns empty lists when nothing is expired", async () => {
      await addFreeSections(await addDossier({ expires_at: ahead(5) }));
      expect(await expirePublicDossiers(db, NOW_ISO)).toEqual({ ids: [], evidenceKeys: [] });
      expect((await db.prepare("SELECT COUNT(*) AS n FROM sections").first<{ n: number }>())?.n).toBe(4);
      await expect(expirePublicDossiers(db, "soon")).rejects.toThrow(RangeError);
    });
  });
});

describe("stored JSON that fails to parse", () => {
  const BAD = "{not json: owner JANE Q PUBLIC";

  it("is read as null and logged by column name only, for every JSON column", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await addDossier({ id: "bad-json" });
    await db.prepare("UPDATE dossiers SET units = ?, resolution_detail = ? WHERE id = ?").bind(BAD, BAD, id).run();
    expect(await getDossier(db, id)).toMatchObject({ id, units: null, resolution_detail: null });

    await upsertSection(db, id, "tax", { status: "ok" });
    await db.prepare("UPDATE sections SET data = ? WHERE dossier_id = ?").bind(BAD, id).run();
    expect((await getSections(db, id))[0].data).toBeNull();

    const eventId = await insertEvent(db, { opa_account: OPA, kind: "other", summary: "x" });
    await db.prepare("UPDATE events SET rows = ?, before = ?, after = ? WHERE id = ?").bind(BAD, BAD, BAD, eventId).run();
    expect((await listEventsForOpa(db, OPA))[0]).toMatchObject({ rows: [], before: null, after: null });

    await db.prepare("INSERT INTO parcels (opa_account, last_section_data) VALUES (?, ?)").bind(OPA, BAD).run();
    expect(await getParcelSection(db, OPA, "property")).toBeNull();

    const lines = logged.mock.calls.map((call) => call.map(String).join(" "));
    for (const column of ["dossiers.units", "dossiers.resolution_detail", "sections.data", "events.rows", "events.before", "events.after", "parcels.last_section_data"]) {
      expect(lines.some((line) => line.includes(column)), column).toBe(true);
    }
    expect(lines.some((line) => line.includes("JANE") || line.includes("not json"))).toBe(false);
  });

  it("logs nothing for a column that parses or is NULL", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await addDossier({ units: { count: 1, list: null, list_url: "u" } });
    await upsertSection(db, id, "tax", { status: "ok", data: { a: 1 } });
    await upsertSection(db, id, "zoning", { status: "ok" });
    await getDossier(db, id);
    await getSections(db, id);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("sections", () => {
  it("upsertSection inserts a row, then changes only the fields it is given", async () => {
    const id = await addDossier();
    await upsertSection(db, id, "tax", { status: "pending", method: "agent", source_url: "https://tax-services.phila.gov/_/" });
    expect((await getSections(db, id))[0]).toMatchObject({
      dossier_id: id, section_id: "tax", status: "pending", method: "agent", source_url: "https://tax-services.phila.gov/_/",
      data: null, evidence_key: null, run_id: null, error: null, spend_usd: null, rows_returned: null, depth: null,
    });

    await upsertSection(db, id, "tax", {
      status: "ok", checked_at: "2026-11-03T12:05:00Z", data: { balance_usd: 0, delinquent: false }, evidence_key: "evidence/x/tax.jpg",
      run_id: "run-9", spend_usd: 0.144, rows_returned: 1, depth: "full",
    });
    // A later partial update: the data, the evidence and the earlier fields stay.
    await upsertSection(db, id, "tax", { error: "late note" });
    await upsertSection(db, id, "tax", { spend_usd: 0.2 });
    const [row, ...rest] = await getSections(db, id);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      status: "ok", method: "agent", source_url: "https://tax-services.phila.gov/_/", checked_at: "2026-11-03T12:05:00.000Z",
      data: { balance_usd: 0, delinquent: false }, evidence_key: "evidence/x/tax.jpg", run_id: "run-9", error: "late note",
      spend_usd: 0.2, rows_returned: 1, depth: "full",
    });
  });

  it("an explicit null clears a field; an undefined one is not given", async () => {
    const id = await addDossier();
    await upsertSection(db, id, "flood", { status: "error", method: "agent", error: "agent_timeout", data: { a: 1 } });
    await upsertSection(db, id, "flood", { status: "ok", error: null, data: undefined });
    expect((await getSections(db, id))[0]).toMatchObject({ status: "ok", error: null, data: { a: 1 } });
    await upsertSection(db, id, "flood", { data: null });
    expect((await getSections(db, id))[0].data).toBeNull();
    const raw = await db.prepare("SELECT data FROM sections WHERE dossier_id = ?").bind(id).first<{ data: string | null }>();
    expect(raw?.data).toBeNull(); // SQL NULL, not the text "null"
  });

  it("a row inserted without a status starts as pending, and a status can never be set to null", async () => {
    const id = await addDossier();
    await upsertSection(db, id, "tax", { method: "agent" });
    expect((await getSections(db, id))[0].status).toBe("pending");
    await upsertSection(db, id, "tax", { status: "ok" });
    await upsertSection(db, id, "tax", { error: "a note" }); // an update that gives no status keeps the stored one
    expect((await getSections(db, id))[0]).toMatchObject({ status: "ok", error: "a note" });
    await expect(upsertSection(db, id, "tax", { status: null } as never)).rejects.toThrow(/status.*null|null.*status/);
    expect((await getSections(db, id))[0].status).toBe("ok");
  });

  it("upsertSection rejects a column it does not write", async () => {
    const id = await addDossier();
    await expect(upsertSection(db, id, "tax", { dossier_id: "other" } as never)).rejects.toThrow(/not writable/);
    await expect(upsertSection(db, id, "tax", { nope: 1 } as never)).rejects.toThrow(/not writable/);
    await expect(upsertSection(db, id, "tax", { checked_at: "never" })).rejects.toThrow(RangeError);
  });

  it("getSections returns the rows in sheet order, not insertion order, with parsed data", async () => {
    const id = await addDossier();
    const insertion: SectionId[] = ["li_deep", "schools", "deeds", "property", "flood", "licenses_inspections", "tax", "zoning", "assessment_history"];
    for (const sectionId of insertion) await upsertSection(db, id, sectionId, { status: "ok", data: { id: sectionId } });
    await upsertSection(db, "other-dossier", "property", { status: "error" });
    const rows = await getSections(db, id);
    expect(rows.map((r) => r.section_id)).toEqual(SECTIONS.map((s) => s.id));
    expect(rows.map((r) => r.section_id)).toEqual([
      "property", "zoning", "licenses_inspections", "deeds", "assessment_history", "tax", "flood", "schools", "li_deep",
    ]);
    expect(rows[3].data).toEqual({ id: "deeds" });
    expect(await getSections(db, "unknown")).toEqual([]);
  });

  it("setSectionStatus moves the status and writes the reason, clearing an old reason when none is given", async () => {
    const id = await addDossier();
    await upsertSection(db, id, "tax", { status: "pending", method: "agent", data: { keep: true }, run_id: "run-1" });
    expect(await setSectionStatus(db, id, "tax", "error", "agent_timeout")).toBe(true);
    expect((await getSections(db, id))[0]).toMatchObject({ status: "error", error: "agent_timeout", data: { keep: true }, run_id: "run-1" });
    expect(await setSectionStatus(db, id, "tax", "pending")).toBe(true);
    expect((await getSections(db, id))[0]).toMatchObject({ status: "pending", error: null, data: { keep: true } });
    expect(await setSectionStatus(db, id, "flood", "ok")).toBe(false); // no such row: nothing is created
    expect(await getSections(db, id)).toHaveLength(1);
    expect(await setSectionStatus(db, "nope", "tax", "ok")).toBe(false);
  });

  it("pendingAgentSections lists the pending Agent sections of that dossier in sheet order", async () => {
    const id = await addDossier();
    await upsertSection(db, id, "schools", { status: "pending", method: "agent" });
    await upsertSection(db, id, "li_deep", { status: "pending", method: "agent" });
    await upsertSection(db, id, "tax", { status: "pending", method: "agent" });
    await upsertSection(db, id, "assessment_history", { status: "pending", method: "agent" });
    await upsertSection(db, id, "flood", { status: "skipped", method: "agent" });
    await upsertSection(db, id, "property", { status: "pending", method: "fetch" });
    await upsertSection(db, id, "deeds", { status: "ok", method: "fetch" });
    await upsertSection(db, "other", "zoning", { status: "pending", method: "agent" });
    expect(await pendingAgentSections(db, id)).toEqual(["assessment_history", "tax", "schools", "li_deep"]);
    await setSectionStatus(db, id, "tax", "ok");
    expect(await pendingAgentSections(db, id)).toEqual(["assessment_history", "schools", "li_deep"]);
    expect(await pendingAgentSections(db, "unknown")).toEqual([]);
  });
});

describe("parcels", () => {
  const property = () => must(parseProperty(fx("property-1234-market.md")));
  const li = () => must(parseLi(fx("li-1234-market.md")));

  it("has nothing for an account that was never written", async () => {
    expect(await getParcelSection(db, OPA, "property")).toBeNull();
  });

  it("upsertParcelSection stores a section's data and getParcelSection returns it", async () => {
    await upsertParcelSection(db, OPA, "property", property(), "1234 MARKET ST");
    expect(await getParcelSection(db, OPA, "property")).toEqual(property());
    const row = await db.prepare("SELECT * FROM parcels WHERE opa_account = ?").bind(OPA).first<{ address_resolved: string; updated_at: string }>();
    expect(row?.address_resolved).toBe("1234 MARKET ST");
    expect(row?.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("merges: writing li keeps property, and a second write of the same section overwrites it", async () => {
    await upsertParcelSection(db, OPA, "property", property(), "1234 MARKET ST");
    await upsertParcelSection(db, OPA, "licenses_inspections", li());
    expect(await getParcelSection(db, OPA, "property")).toEqual(property());
    expect(await getParcelSection(db, OPA, "licenses_inspections")).toEqual(li());

    const changed = { ...property(), owners: ["NEW OWNER LLC"], assessed_value_usd: 1 };
    await upsertParcelSection(db, OPA, "property", changed);
    expect(await getParcelSection(db, OPA, "property")).toEqual(changed);
    expect(await getParcelSection(db, OPA, "licenses_inspections")).toEqual(li());

    // The overwrite replaces the whole section; it does not merge fields into the old one.
    const smaller = { ...li(), permits: { count: 0, recent: [], depth: "recent" as const, all_url: "https://li.phila.gov/x" } };
    await upsertParcelSection(db, OPA, "licenses_inspections", smaller as never);
    expect(await getParcelSection(db, OPA, "licenses_inspections")).toEqual(smaller);
    // Still one row; the address given earlier is kept when a later write gives none.
    const { results } = await db.prepare("SELECT address_resolved FROM parcels").all<{ address_resolved: string }>();
    expect(results).toEqual([{ address_resolved: "1234 MARKET ST" }]);
  });

  it("moves updated_at forward and updates the address only when one is given", async () => {
    await upsertParcelSection(db, OPA, "property", property(), "1234 MARKET ST");
    await db.prepare("UPDATE parcels SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    await upsertParcelSection(db, OPA, "zoning", must(parseZoning(fx("zoning-1234-market.md"))));
    const row = await db.prepare("SELECT address_resolved, updated_at FROM parcels").first<{ address_resolved: string; updated_at: string }>();
    expect(row?.address_resolved).toBe("1234 MARKET ST");
    expect(row!.updated_at > "2020-01-01T00:00:00.000Z").toBe(true);
    await upsertParcelSection(db, OPA, "zoning", must(parseZoning(fx("zoning-1234-market.md"))), "1234 MARKET ST, PHILADELPHIA");
    expect((await db.prepare("SELECT address_resolved FROM parcels").first<{ address_resolved: string }>())?.address_resolved).toBe("1234 MARKET ST, PHILADELPHIA");
  });

  it("keeps accounts apart and rejects a section id that is not in the registry", async () => {
    await upsertParcelSection(db, OPA, "property", property());
    expect(await getParcelSection(db, "111111111", "property")).toBeNull();
    await expect(upsertParcelSection(db, OPA, 'x"] ; DROP' as never, {} as never)).rejects.toThrow(/not a section id/);
    await expect(getParcelSection(db, OPA, "constructor" as never)).rejects.toThrow(/not a section id/);
  });
});

describe("watches", () => {
  const watch = (over: Partial<NewWatch> = {}): NewWatch => ({
    opa_account: OPA, kind: "li", monitor_id: "mon-1", added_by: "public", expires_at: ahead(24), ...over,
  });

  it("inserts a watch (active by default) and finds it by id and by monitor id", async () => {
    const id = await insertWatch(db, watch({ callback_url: "https://example.test/hook", expires_at: "2026-11-10T12:00:00Z" }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await getWatch(db, id);
    expect(row).toMatchObject({
      id, opa_account: OPA, kind: "li", monitor_id: "mon-1", added_by: "public", callback_url: "https://example.test/hook",
      expires_at: "2026-11-10T12:00:00.000Z", status: "active", last_applied_at: null,
    });
    expect(row!.created_at).toMatch(/Z$/);
    expect((await getWatchByMonitorId(db, "mon-1"))?.id).toBe(id);
    expect(await getWatchByMonitorId(db, "nope")).toBeNull();
    expect(await getWatch(db, "nope")).toBeNull();
    expect(await insertWatch(db, watch({ id: "given", kind: "property", monitor_id: null, expires_at: null }))).toBe("given");
    expect(await getWatch(db, "given")).toMatchObject({ monitor_id: null, expires_at: null, callback_url: null });
  });

  it("lists watches oldest first, filtered by account, status, adder and kind", async () => {
    await insertWatch(db, watch({ id: "w1", opa_account: "111111111", kind: "li", monitor_id: "m1", added_by: "curated", expires_at: null }));
    await insertWatch(db, watch({ id: "w2", opa_account: "111111111", kind: "property", monitor_id: "m2", added_by: "curated", expires_at: null }));
    await insertWatch(db, watch({ id: "w3", opa_account: "222222222", kind: "li", monitor_id: "m3", added_by: "public" }));
    await insertWatch(db, watch({ id: "w4", opa_account: "222222222", kind: "property", monitor_id: "m4", added_by: "public", status: "expired" }));
    await insertWatch(db, watch({ id: "w5", opa_account: "333333333", kind: "li", monitor_id: "m5", added_by: "admin", status: "removed", expires_at: null }));
    const ids = async (filter = {}) => (await listWatches(db, filter)).map((w) => w.id);
    expect(await ids()).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    expect(await ids({ opa: "222222222" })).toEqual(["w3", "w4"]);
    expect(await ids({ status: "active" })).toEqual(["w1", "w2", "w3"]);
    expect(await ids({ addedBy: "curated" })).toEqual(["w1", "w2"]);
    expect(await ids({ kind: "property" })).toEqual(["w2", "w4"]);
    expect(await ids({ opa: "222222222", status: "active", kind: "li" })).toEqual(["w3"]);
    expect(await ids({ status: "removed", addedBy: "admin" })).toEqual(["w5"]);
    expect(await ids({ opa: "999999999" })).toEqual([]);
  });

  it("setWatchStatus changes the status of one watch", async () => {
    const id = await insertWatch(db, watch());
    expect(await setWatchStatus(db, id, "removed")).toBe(true);
    expect((await getWatch(db, id))?.status).toBe("removed");
    expect(await setWatchStatus(db, "nope", "failed")).toBe(false);
  });

  it("dueForExpiry returns the active watches with a Monitor that are due, soonest first, and writes nothing", async () => {
    await insertWatch(db, watch({ id: "due-2", monitor_id: "m2", expires_at: ago(1) }));
    await insertWatch(db, watch({ id: "due-1", monitor_id: "m1", expires_at: ago(3) }));
    await insertWatch(db, watch({ id: "edge", monitor_id: "m3", expires_at: NOW_ISO }));
    await insertWatch(db, watch({ id: "later", monitor_id: "m4", expires_at: ahead(1) }));
    await insertWatch(db, watch({ id: "no-expiry", monitor_id: "m5", added_by: "curated", expires_at: null }));
    await insertWatch(db, watch({ id: "removed", monitor_id: "m6", expires_at: ago(9), status: "removed" }));
    await insertWatch(db, watch({ id: "already", monitor_id: "m7", expires_at: ago(9), status: "expired" }));
    await insertWatch(db, watch({ id: "no-monitor", monitor_id: null, expires_at: ago(9) }));
    const rows = await dueForExpiry(db, NOW_ISO);
    expect(rows.map((r) => r.id)).toEqual(["due-1", "due-2", "edge"]);
    expect(rows.every((r) => r.status === "active" && r.monitor_id !== null)).toBe(true);
    // Nothing was written: the same watches are due again, and they still hold their slots.
    expect((await dueForExpiry(db, NOW_ISO)).map((r) => r.id)).toEqual(["due-1", "due-2", "edge"]);
    expect((await listWatches(db, { status: "expired" })).map((w) => w.id)).toEqual(["already"]);
    expect(await countMonitors(db)).toBe(5); // due-1, due-2, edge, later, no-expiry
    await expect(dueForExpiry(db, "soon")).rejects.toThrow(RangeError);
  });

  it("dueForExpiry protocol: a watch is flagged expired only after its Monitor is deleted; a failed delete is retried next time", async () => {
    await insertWatch(db, watch({ id: "w-ok", monitor_id: "m1", expires_at: ago(2) }));
    await insertWatch(db, watch({ id: "w-stuck", monitor_id: "m2", expires_at: ago(1) }));
    const deleted: string[] = [];
    const deleteMonitor = async (monitorId: string) => {
      if (monitorId === "m2") throw new Error("delete failed");
      deleted.push(monitorId);
    };
    // The cron's loop: delete the Monitor, then flag the watch; a failure leaves it active.
    for (const w of await dueForExpiry(db, NOW_ISO)) {
      try {
        await deleteMonitor(w.monitor_id!);
        await setWatchStatus(db, w.id, "expired");
      } catch {
        // stays active
      }
    }
    expect(deleted).toEqual(["m1"]);
    expect((await dueForExpiry(db, ahead(1))).map((r) => r.id)).toEqual(["w-stuck"]);
    expect((await getWatch(db, "w-stuck"))?.status).toBe("active");
    expect((await getWatch(db, "w-ok"))?.status).toBe("expired");
    // The stuck watch still holds a TinyFish monitor, so it still takes a slot.
    expect(await countMonitors(db)).toBe(1);
  });

  it("countMonitors counts every active watch that has a Monitor, whether or not it is past its expiry", async () => {
    await insertWatch(db, watch({ id: "pub", monitor_id: "m1", expires_at: ahead(5) }));
    await insertWatch(db, watch({ id: "cur", monitor_id: "m2", added_by: "curated", expires_at: null }));
    await insertWatch(db, watch({ id: "adm", monitor_id: "m3", added_by: "admin", kind: "property", expires_at: null }));
    expect(await countMonitors(db)).toBe(3);

    await insertWatch(db, watch({ id: "flagged-expired", monitor_id: "m4", status: "expired", expires_at: ago(1) }));
    await insertWatch(db, watch({ id: "removed", monitor_id: "m5", status: "removed", expires_at: null }));
    await insertWatch(db, watch({ id: "failed", monitor_id: "m6", status: "failed", expires_at: null }));
    await insertWatch(db, watch({ id: "no-monitor", monitor_id: null, expires_at: ahead(5) }));
    expect(await countMonitors(db)).toBe(3);

    // Past its expiry but still active: TinyFish still holds its Monitor until the cron deletes it, so it counts.
    await insertWatch(db, watch({ id: "overdue", monitor_id: "m7", expires_at: ago(1) }));
    expect(await countMonitors(db)).toBe(4);
    // Once the Monitor is deleted and the watch is flagged, the slot is free.
    await setWatchStatus(db, "overdue", "expired");
    expect(await countMonitors(db)).toBe(3);
  });

  it("countPublicWatches counts only the public watches that hold a Monitor, overdue ones included", async () => {
    await insertWatch(db, watch({ id: "p1", monitor_id: "m1", expires_at: ahead(5) }));
    await insertWatch(db, watch({ id: "p2", monitor_id: "m2", kind: "property", expires_at: ahead(5) }));
    await insertWatch(db, watch({ id: "p3", monitor_id: "m3", expires_at: ago(1) })); // overdue, Monitor not deleted yet
    await insertWatch(db, watch({ id: "p4", monitor_id: "m4", status: "expired", expires_at: ago(9) }));
    await insertWatch(db, watch({ id: "p5", monitor_id: null }));
    await insertWatch(db, watch({ id: "c1", monitor_id: "m6", added_by: "curated", expires_at: null }));
    await insertWatch(db, watch({ id: "a1", monitor_id: "m7", added_by: "admin", expires_at: null }));
    expect(await countPublicWatches(db)).toBe(3);
    expect(await countMonitors(db)).toBe(5);
    await setWatchStatus(db, "p3", "expired");
    expect(await countPublicWatches(db)).toBe(2);
  });
});

describe("events", () => {
  const event = (over: Partial<Parameters<typeof insertEvent>[1]> = {}) => ({
    opa_account: OPA, kind: "new_permit" as const, summary: "New permit EP-2026-000778.", ...over,
  });

  it("stores rows, before and after as JSON and reads them back parsed", async () => {
    const id = await insertEvent(db, event({
      rows: [{ id: "EP-2026-000778" }], before: { count: 154 }, after: { count: 155 },
      source_url: "https://atlas.phila.gov/1234%20MARKET%20ST/li", monitor_run_id: "run-1", at: "2026-11-03T11:00:00Z",
    }));
    const [row] = await listEventsForOpa(db, OPA);
    expect(row).toEqual({
      id, opa_account: OPA, kind: "new_permit", summary: "New permit EP-2026-000778.", rows: [{ id: "EP-2026-000778" }],
      before: { count: 154 }, after: { count: 155 }, source_url: "https://atlas.phila.gov/1234%20MARKET%20ST/li",
      monitor_run_id: "run-1", at: "2026-11-03T11:00:00.000Z", notified_at: null,
    });
    const raw = await db.prepare("SELECT rows, before, after FROM events WHERE id = ?").bind(id).first<{ rows: string; before: string; after: string }>();
    expect(JSON.parse(raw!.rows)).toEqual([{ id: "EP-2026-000778" }]);
  });

  it("defaults: empty rows, null before and after, at is now; a bad time throws", async () => {
    const id = await insertEvent(db, event({ kind: "other", id: "e-default" }));
    expect(id).toBe("e-default");
    const [row] = await listEventsForOpa(db, OPA);
    expect(row).toMatchObject({ rows: [], before: null, after: null, source_url: null, monitor_run_id: null, notified_at: null });
    expect(Date.now() - Date.parse(row!.at!)).toBeLessThan(60_000);
    await expect(insertEvent(db, event({ at: "yesterday" }))).rejects.toThrow(RangeError);
  });

  it("lists newest first, filtered by since (inclusive) and account, and capped by limit", async () => {
    await insertEvent(db, event({ id: "e1", at: ago(10) }));
    await insertEvent(db, event({ id: "e2", at: ago(8), opa_account: "111111111", kind: "sale" }));
    await insertEvent(db, event({ id: "e3", at: ago(6) }));
    await insertEvent(db, event({ id: "e4", at: ago(6), kind: "new_violation" })); // same instant as e3: later insert first
    await insertEvent(db, event({ id: "e5", at: ago(1), opa_account: "111111111" }));
    const ids = async (opts: { since?: string; opa?: string; limit: number }) => (await listEvents(db, opts)).map((e) => e.id);
    expect(await ids({ limit: 50 })).toEqual(["e5", "e4", "e3", "e2", "e1"]);
    expect(await ids({ limit: 2 })).toEqual(["e5", "e4"]);
    expect(await ids({ limit: 50, opa: OPA })).toEqual(["e4", "e3", "e1"]);
    expect(await ids({ limit: 50, since: ago(6) })).toEqual(["e5", "e4", "e3"]);
    expect(await ids({ limit: 50, since: ago(8), opa: "111111111" })).toEqual(["e5", "e2"]);
    expect(await ids({ limit: 50, since: ahead(1) })).toEqual([]);
    expect(await ids({ limit: 0 })).toEqual([]);
    expect(await ids({ limit: -3 })).toEqual([]);
    expect((await listEventsForOpa(db, "111111111")).map((e) => e.id)).toEqual(["e5", "e2"]);
    expect(await listEventsForOpa(db, "999999999")).toEqual([]);
  });

  it("listEvents caps limit at MAX_EVENTS_LIMIT and rejects a limit that is not a finite number", async () => {
    expect(MAX_EVENTS_LIMIT).toBe(500);
    await db.exec("INSERT INTO events (id, opa_account, kind, summary, at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501) SELECT 'bulk-' || i, '883309050', 'other', 'bulk', '2026-11-03T10:00:00.000Z' FROM n");
    expect(await listEvents(db, { limit: 501 })).toHaveLength(MAX_EVENTS_LIMIT);
    expect(await listEvents(db, { limit: 1_000_000 })).toHaveLength(MAX_EVENTS_LIMIT);
    expect(await listEvents(db, { limit: 500 })).toHaveLength(500);
    expect(await listEvents(db, { limit: 499.9 })).toHaveLength(499);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(listEvents(db, { limit: bad })).rejects.toThrow(RangeError);
    }
  });

  it("markNotified stamps the first delivery time and leaves it after that", async () => {
    const id = await insertEvent(db, event());
    expect(await markNotified(db, id, "2026-11-03T12:01:00Z")).toBe(true);
    expect((await listEventsForOpa(db, OPA))[0]?.notified_at).toBe("2026-11-03T12:01:00.000Z");
    expect(await markNotified(db, id, "2026-11-03T13:00:00Z")).toBe(false);
    expect((await listEventsForOpa(db, OPA))[0]?.notified_at).toBe("2026-11-03T12:01:00.000Z");
    expect(await markNotified(db, "nope", NOW_ISO)).toBe(false);
  });
});

describe("public use", () => {
  it("today is zeros for a visitor with no row", async () => {
    expect(await today(db, "nobody", { now: NOW })).toEqual({ dossiers: 0, watches: 0, upgrades: 0 });
  });

  it("claimPublicUse gives a slot until the limit is reached, then refuses without counting", async () => {
    const claim = () => claimPublicUse(db, "h1", "dossiers", 3, { now: NOW });
    expect([await claim(), await claim(), await claim(), await claim(), await claim()]).toEqual([true, true, true, false, false]);
    expect(await today(db, "h1", { now: NOW })).toEqual({ dossiers: 3, watches: 0, upgrades: 0 });
  });

  it("counts each field separately, each visitor separately and each UTC day separately", async () => {
    expect(await claimPublicUse(db, "h1", "dossiers", 1, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "dossiers", 1, { now: NOW })).toBe(false);
    expect(await claimPublicUse(db, "h1", "watches", 1, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "upgrades", 1, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "upgrades", 1, { now: NOW })).toBe(false);
    expect(await claimPublicUse(db, "h2", "dossiers", 1, { now: NOW })).toBe(true);
    expect(await today(db, "h1", { now: NOW })).toEqual({ dossiers: 1, watches: 1, upgrades: 1 });
    expect(await today(db, "h2", { now: NOW })).toEqual({ dossiers: 1, watches: 0, upgrades: 0 });

    const lastSecond = new Date("2026-11-03T23:59:59.999Z");
    const nextDay = new Date("2026-11-04T00:00:00.000Z");
    expect(await claimPublicUse(db, "h1", "dossiers", 1, { now: lastSecond })).toBe(false); // same UTC day as NOW
    expect(await claimPublicUse(db, "h1", "dossiers", 1, { now: nextDay })).toBe(true);
    expect(await today(db, "h1", { now: nextDay })).toEqual({ dossiers: 1, watches: 0, upgrades: 0 });
    expect(await today(db, "h1", { now: NOW })).toEqual({ dossiers: 1, watches: 1, upgrades: 1 });
    const { results } = await db.prepare("SELECT ip_hash, day FROM public_use ORDER BY ip_hash, day").all();
    expect(results).toEqual([
      { ip_hash: "h1", day: "2026-11-03" },
      { ip_hash: "h1", day: "2026-11-04" },
      { ip_hash: "h2", day: "2026-11-03" },
    ]);
  });

  it("a limit below 1 never grants a slot, and a fractional limit rounds down", async () => {
    expect(await claimPublicUse(db, "h1", "dossiers", 0, { now: NOW })).toBe(false);
    expect(await claimPublicUse(db, "h1", "dossiers", -1, { now: NOW })).toBe(false);
    expect(await claimPublicUse(db, "h1", "dossiers", Number.NaN, { now: NOW })).toBe(false);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM public_use").first<{ n: number }>())?.n).toBe(0);
    expect(await claimPublicUse(db, "h1", "dossiers", 1.9, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "dossiers", 1.9, { now: NOW })).toBe(false);
  });

  it("a lowered limit refuses a visitor who is already above it", async () => {
    for (let i = 0; i < 3; i++) await claimPublicUse(db, "h1", "watches", 5, { now: NOW });
    expect(await claimPublicUse(db, "h1", "watches", 2, { now: NOW })).toBe(false);
    expect((await today(db, "h1", { now: NOW })).watches).toBe(3);
  });

  it("two concurrent claims at limit - 1 give exactly one slot", async () => {
    await claimPublicUse(db, "h1", "upgrades", 3, { now: NOW });
    await claimPublicUse(db, "h1", "upgrades", 3, { now: NOW });
    const both = await Promise.all([
      claimPublicUse(db, "h1", "upgrades", 3, { now: NOW }),
      claimPublicUse(db, "h1", "upgrades", 3, { now: NOW }),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect((await today(db, "h1", { now: NOW })).upgrades).toBe(3);
  });

  it("many concurrent first claims from a new visitor give exactly `limit` slots", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimPublicUse(db, "fresh", "dossiers", 3, { now: NOW })));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect((await today(db, "fresh", { now: NOW })).dossiers).toBe(3);
  });

  it("releasePublicUse gives a claimed slot back, never below zero, and only for that visitor, field and day", async () => {
    expect(await releasePublicUse(db, "h1", "upgrades", { now: NOW })).toBe(false); // nothing to give back
    expect((await db.prepare("SELECT COUNT(*) AS n FROM public_use").first<{ n: number }>())?.n).toBe(0); // and no row made
    expect(await claimPublicUse(db, "h1", "upgrades", 1, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "upgrades", 1, { now: NOW })).toBe(false);
    expect(await claimPublicUse(db, "h1", "dossiers", 3, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "dossiers", 3, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h2", "upgrades", 1, { now: NOW })).toBe(true);

    expect(await releasePublicUse(db, "h1", "upgrades", { now: NOW })).toBe(true);
    expect(await today(db, "h1", { now: NOW })).toEqual({ dossiers: 2, watches: 0, upgrades: 0 });
    expect(await today(db, "h2", { now: NOW })).toEqual({ dossiers: 0, watches: 0, upgrades: 1 });
    // The refunded slot can be claimed again, once.
    expect(await claimPublicUse(db, "h1", "upgrades", 1, { now: NOW })).toBe(true);
    expect(await claimPublicUse(db, "h1", "upgrades", 1, { now: NOW })).toBe(false);

    // Floor of zero: a second release after the counter is empty changes nothing.
    expect(await releasePublicUse(db, "h1", "upgrades", { now: NOW })).toBe(true);
    expect(await releasePublicUse(db, "h1", "upgrades", { now: NOW })).toBe(false);
    expect(await releasePublicUse(db, "h1", "upgrades", { now: NOW })).toBe(false);
    expect((await today(db, "h1", { now: NOW })).upgrades).toBe(0);
    const { results } = await db.prepare("SELECT dossiers, watches, upgrades FROM public_use WHERE ip_hash = 'h1'").all();
    expect(results).toEqual([{ dossiers: 2, watches: 0, upgrades: 0 }]);

    // Another day's counter is not touched.
    const nextDay = new Date("2026-11-04T08:00:00.000Z");
    await claimPublicUse(db, "h1", "dossiers", 3, { now: nextDay });
    await releasePublicUse(db, "h1", "dossiers", { now: NOW });
    expect(await today(db, "h1", { now: nextDay })).toEqual({ dossiers: 1, watches: 0, upgrades: 0 });
    expect((await today(db, "h1", { now: NOW })).dossiers).toBe(1);
    await expect(releasePublicUse(db, "h1", "ip_hash" as never, { now: NOW })).rejects.toThrow(/no counter/);
  });

  it("rejects a field that is not a counter", async () => {
    await expect(claimPublicUse(db, "h1", "ip_hash" as never, 3, { now: NOW })).rejects.toThrow(/no counter/);
    await expect(claimPublicUse(db, "h1", "constructor" as never, 3, { now: NOW })).rejects.toThrow(/no counter/);
  });
});
