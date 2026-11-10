// The home and a dossier: every condition the plan names, plus escaped city text
// and a note that is never echoed. Fixtures are invented; no real person's name.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import credits from "../design/credits.json";
import { visitorHash } from "../src/auth";
import {
  AGENT_MAX_DURATION_SECONDS,
  AGENT_MAX_STEPS,
  AGENT_SECTION_MAX_USD,
  CACHE_HOURS,
  CURATED_ADDRESSES,
  DEEP_ROWS_MAX,
  FETCH_RETRY_DELAY_MS,
  FETCH_RETRY_ON_LOADING,
  FLOOD_RETRY_DAYS,
  MAX_MONITORS,
  PUBLIC_AGENT_PAUSE_USD,
  PUBLIC_DOSSIER_TTL_DAYS,
  PUBLIC_DOSSIERS_PER_IP_PER_DAY,
  PUBLIC_UPGRADES_PER_IP_PER_DAY,
  PUBLIC_WATCHES_PER_IP_PER_DAY,
  PUBLIC_WATCH_SLOTS,
  PUBLIC_WATCH_TTL_DAYS,
  SPEND_PAUSE_USD,
} from "../src/core/limits";
import { insertDossier } from "../src/db/dossiers";
import { insertEvent } from "../src/db/events";
import { getSections, upsertSection } from "../src/db/sections";
import { parseDeeds } from "../src/sections/deeds";
import { parseLi } from "../src/sections/li";
import { parseProperty } from "../src/sections/property";
import { SECTIONS } from "../src/sections/index";
import type { SectionId, SectionStatus } from "../src/sections/types";
import { parseZoning } from "../src/sections/zoning";
import { stamp, usd } from "../src/site/format";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";

type Json = Record<string, unknown>;

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fx(name: string): string {
  const text = fixtures[`./fixtures/atlas/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}

const FETCH_API = "https://api.fetch.tinyfish.ai";
const OPA = "883309050";
const STREET = "1234 MARKET ST";
const NOW = "2026-11-09T17:34:00.000Z";
const FREE: SectionId[] = ["property", "zoning", "licenses_inspections", "deeds"];
const AGENT: SectionId[] = ["assessment_history", "tax", "flood", "schools", "li_deep"];
const tabUrl = (address: string, tab: string) => `https://atlas.phila.gov/${encodeURIComponent(address)}/${tab}`;

function must<T>(v: T | null): T {
  if (v === null) throw new Error("expected data");
  return v;
}

const UNREACHABLE = Symbol("target_unreachable");
type Answer = string | typeof UNREACHABLE;

function mockAtlas(routes: Record<string, Answer | Answer[]>): void {
  const queues = new Map(Object.entries(routes).map(([url, a]) => [url, Array.isArray(a) ? [...a] : [a]]));
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0]!;
      const queue = queues.get(url);
      if (!queue) throw new Error(`test has no answer for ${url}`);
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (answer === UNREACHABLE) {
        return Response.json({ error: { code: "target_unreachable", message: "down" } }, { status: 400 });
      }
      return Response.json({ results: [{ url, final_url: url, title: "Atlas", text: answer }], errors: [] });
    },
  });
}

function market(input = "1234 Market St"): Record<string, Answer> {
  return {
    [tabUrl(input, "property")]: fx("property-1234-market.md"),
    [tabUrl(STREET, "li")]: fx("li-1234-market.md"),
    [tabUrl(STREET, "zoning")]: fx("zoning-1234-market.md"),
    [tabUrl(STREET, "deeds")]: fx("deeds-1234-market.md"),
  };
}

async function page(path: string, init?: RequestInit): Promise<{ res: Response; html: string }> {
  const res = await callWorker(path, init);
  return { res, html: await res.text() };
}

function formPost(path: string, fields: Record<string, string>, extra: HeadersInit = {}): Promise<Response> {
  return callWorker(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.40", ...extra },
    body: new URLSearchParams(fields),
  });
}

const dataFor = (id: SectionId): unknown => {
  if (id === "property") return must(parseProperty(fx("property-1234-market.md")));
  if (id === "zoning") return must(parseZoning(fx("zoning-1234-market.md")));
  if (id === "licenses_inspections") return must(parseLi(fx("li-1234-market.md")));
  if (id === "deeds") return must(parseDeeds(fx("deeds-1234-market.md")));
  if (id === "assessment_history")
    return { years: [{ year: 2025, market_value_usd: 148232900, taxable_land_usd: 1, taxable_improvement_usd: 2, exempt_land_usd: 0, exempt_improvement_usd: 0, raw: { market_value: "$148,232,900" } }] };
  if (id === "tax") return { balance_usd: 0, delinquent: false, as_of: "2025-01-01", raw: { balance_usd: "$0.00", as_of: "01/01/2025" } };
  if (id === "schools") return { catchment: [{ level: "elementary", name: "North Light School", address: "1 Example St", distance_miles: 0.4, raw: { distance_miles: "0.4" } }] };
  if (id === "flood") return { flood_zone: "X", firm_panel: "4207570083G", effective_date: "2015-01-01" };
  if (id === "li_deep")
    return { permits: { count: 155, rows: [{ number: "EP-2026-004102", type: "Electrical Permit", status: "Issued", date: "2026-09-15", raw: { date: "09/15/2026" } }], rows_returned: 1, truncated: true } };
  return null;
};

async function seedResolved(
  id: string,
  opts: {
    added_by?: "public" | "admin" | "curated";
    resolution?: "exact" | "fuzzy" | "parent";
    input?: string;
    resolved?: string;
    opa?: string;
    units?: unknown;
    statuses?: Partial<Record<SectionId, SectionStatus>>;
    errors?: Partial<Record<SectionId, string>>;
    evidence?: Partial<Record<SectionId, string | null>>;
    skipData?: SectionId[];
    spend?: number;
    status?: "complete" | "partial" | "failed";
    tier?: "free" | "standard" | "deep";
    hostileOwner?: string;
  } = {},
): Promise<void> {
  await insertDossier(env.DB, {
    id,
    address_input: opts.input ?? "1234 Market St",
    address_resolved: opts.resolved ?? "1234 MARKET ST, PHILADELPHIA, PA 19107-3721",
    opa_account: opts.opa ?? OPA,
    resolution: opts.resolution ?? "exact",
    outcome: "resolved",
    tier: opts.tier ?? "free",
    status: opts.status ?? "complete",
    added_by: opts.added_by ?? "curated",
    created_at: NOW,
    completed_at: opts.status === "partial" ? null : NOW,
    spend_usd: opts.spend ?? 0.008,
    units: (opts.units as never) ?? null,
  });
  for (const adapter of SECTIONS) {
    const sid = adapter.id;
    const status = opts.statuses?.[sid] ?? (FREE.includes(sid) ? "ok" : "skipped");
    let data = opts.skipData?.includes(sid) ? null : status === "ok" || status === "empty" ? dataFor(sid) : null;
    if (sid === "property" && data && opts.hostileOwner) {
      data = { ...(data as object), owners: [opts.hostileOwner] };
    }
    await upsertSection(env.DB, id, sid, {
      status,
      method: adapter.method,
      source_url: adapter.url({ address: STREET, opa: opts.opa ?? OPA }),
      checked_at: status === "pending" || status === "skipped" ? null : NOW,
      evidence_key: opts.evidence && sid in opts.evidence ? opts.evidence[sid] : status === "ok" && FREE.includes(sid) ? `evidence/${id}/${sid}.jpg` : null,
      data: data as never,
      error: opts.errors?.[sid] ?? null,
    });
  }
}

beforeEach(async () => {
  fetchMock.activate();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM watches"),
    env.DB.prepare("DELETE FROM parcels"),
    env.DB.prepare("DELETE FROM sections"),
    env.DB.prepare("DELETE FROM dossiers"),
    env.DB.prepare("DELETE FROM public_use"),
    env.DB.prepare("DELETE FROM spend"),
  ]);
  vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as Awaited<ReturnType<typeof env.DOSSIER_WORKFLOW.create>>);
});

afterEach(() => {
  fetchMock.reset();
  vi.restoreAllMocks();
});

describe("GET /", () => {
  it("serves the home with the address form, nine offices, the empty-events sentence and live figures", async () => {
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('s1', 'screenshot', 0.008, 'seed', ?)")
      .bind(NOW)
      .run();
    const { res, html } = await page("/");
    expect(res.status).toBe(200);
    expect(html).toContain('<form class="ask" action="/go" method="post">');
    expect(html).toContain('name="address"');
    expect(html).toContain("Draw the dossier");
    for (const a of SECTIONS) {
      expect(html).toContain(a.agency.replaceAll("&", "&amp;"));
      expect(html).toContain(a.method === "fetch" ? "Fetch" : "Agent");
    }
    expect(html).toContain("Watched");
    expect(html).toContain("No change has been recorded yet. Monitor reads each watched page twice a day.");
    expect(html).toContain("dossiers built");
    expect(html).toContain("sheets read");
    expect(html).toContain("gaps marked");
    expect(html).toContain("$0.008");
    expect(html).toContain("1234 Market St");
    expect(html).toContain("5600 Germantown Ave");
    expect(html).toContain("4001 Walnut St");
  });

  it("links a demo address to the newest curated dossier and keeps a public one-off off the home", async () => {
    await seedResolved("cur-market", { added_by: "curated" });
    await seedResolved("pub-one", {
      added_by: "public",
      input: "77 Invented Ave",
      resolved: "77 INVENTED AVE, PHILADELPHIA, PA 19103",
      opa: "111111111",
    });
    await insertEvent(env.DB, { opa_account: "111111111", kind: "sale", summary: "Invented sale at a private lookup", at: NOW });
    await env.DB.prepare("INSERT INTO parcels (opa_account, address_resolved) VALUES ('111111111', '77 INVENTED AVE')").run();
    const { html } = await page("/");
    expect(html).toContain('href="/d/cur-market"');
    expect(html).not.toContain("77 Invented Ave");
    expect(html).not.toContain("Invented sale");
    expect(html).toContain("No change has been recorded yet. Monitor reads each watched page twice a day.");
  });

  it("lists a curated watch event and ignores a hostile note", async () => {
    await seedResolved("cur-market", { added_by: "curated" });
    await env.DB.prepare("INSERT INTO parcels (opa_account, address_resolved) VALUES (?, ?)").bind(OPA, "1234 MARKET ST, PHILADELPHIA, PA 19107-3721").run();
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by) VALUES ('w1', ?, 'li', 'm1', 'active', 'curated')")
      .bind(OPA)
      .run();
    await insertEvent(env.DB, { opa_account: OPA, kind: "new_permit", summary: "New permit at 1234 Market St", at: NOW });
    const { html } = await page("/?note=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(html).toContain("New permit at 1234 Market St");
    expect(html).toContain("1234 MARKET ST");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("Three dossiers a day");
  });

  it("keeps the events of a visitor's watched address off the home", async () => {
    await seedResolved("pub-watch", {
      added_by: "public",
      input: "77 Invented Ave",
      resolved: "77 INVENTED AVE, PHILADELPHIA, PA 19103",
      opa: "111111111",
    });
    await env.DB.prepare("INSERT INTO parcels (opa_account, address_resolved) VALUES ('111111111', '77 INVENTED AVE')").run();
    await env.DB.prepare(
      "INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by, owner_hash) VALUES ('w-pub', '111111111', 'li', 'm-pub', 'active', 'public', 'someone')",
    ).run();
    await insertEvent(env.DB, { opa_account: "111111111", kind: "new_permit", summary: "Invented permit at a visitor's watch", at: NOW });
    const { html } = await page("/");
    expect(html).not.toContain("77 INVENTED AVE");
    expect(html).not.toContain("Invented permit");
    expect(html).toContain("No change has been recorded yet. Monitor reads each watched page twice a day.");
  });

  it("shows the sentence for an unusable-field note above the field", async () => {
    const { html } = await page("/?note=unusable");
    expect(html).toContain("Type a Philadelphia address or a 9-digit OPA account.");
  });
});

describe("POST /go", () => {
  it("redirects to the new dossier for a match", async () => {
    mockAtlas(market());
    const res = await formPost("/go", { address: "1234 Market St" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/d\/[0-9a-f-]{36}$/i);
  });

  it("redirects to the failed dossier for no match", async () => {
    mockAtlas({
      [tabUrl("99999 Nowhere St.", "property")]: fx("property-no-record.md"),
      [tabUrl("99999 NOWHERE ST", "property")]: fx("property-no-record.md"),
    });
    const res = await formPost("/go", { address: "99999 Nowhere St." });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/d\//);
    const id = loc.slice(3);
    const row = await env.DB.prepare("SELECT outcome, status FROM dossiers WHERE id = ?").bind(id).first<{ outcome: string; status: string }>();
    expect(row).toEqual({ outcome: "no_match", status: "failed" });
  });

  it("redirects to the home with a note when the field is unusable", async () => {
    const res = await formPost("/go", { address: "   " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?note=unusable#top");
  });

  it("redirects to the home with a note when the atlas is down", async () => {
    // A definite TinyFish 4xx is atlas_unavailable at once. HTTP 500 is retried with
    // ten-second waits; that path is covered in the Fetch tests.
    mockAtlas({ [tabUrl("1234 Market St", "property")]: UNREACHABLE });
    const res = await formPost("/go", { address: "1234 Market St" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?note=atlas#top");
  });

  it("redirects to the home with a note at the daily limit", async () => {
    mockAtlas({
      [tabUrl("99999 Nowhere St.", "property")]: fx("property-no-record.md"),
      [tabUrl("99999 NOWHERE ST", "property")]: fx("property-no-record.md"),
    });
    for (let i = 0; i < 3; i++) {
      const r = await formPost("/go", { address: "99999 Nowhere St." });
      expect(r.status).toBe(303);
    }
    const fourth = await formPost("/go", { address: "99999 Nowhere St." });
    expect(fourth.status).toBe(303);
    expect(fourth.headers.get("location")).toBe("/?note=limit#top");
  });

  it("treats nine digits as an OPA account", async () => {
    mockAtlas({
      [tabUrl(OPA, "property")]: fx("property-1234-market.md"),
      [tabUrl(STREET, "li")]: fx("li-1234-market.md"),
      [tabUrl(STREET, "zoning")]: fx("zoning-1234-market.md"),
      [tabUrl(STREET, "deeds")]: fx("deeds-1234-market.md"),
    });
    const res = await formPost("/go", { address: OPA });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/d\//);
  });
});

describe("GET /d/:id", () => {
  it("renders a read dossier with title, figures, the record by date, index and sheets", async () => {
    await seedResolved("d-read", { evidence: { property: null, zoning: null, licenses_inspections: `evidence/d-read/licenses_inspections.jpg`, deeds: `evidence/d-read/deeds.jpg` } });
    const { res, html } = await page("/d/d-read");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(html).toContain("1234 MARKET ST");
    expect(html).toContain("Philadelphia, PA 19107-3721");
    expect(html).toContain("883309050");
    expect(html).toContain("4 of 9");
    expect(html).toContain("$148,232,900");
    expect(html).toContain("723,780");
    expect(html).toContain("CMX-5");
    expect(html).toContain("155");
    expect(html).toContain("4 open");
    expect(html).toContain("The record, by date");
    expect(html).toContain("Sheet 1 of 9");
    expect(html).toContain("Assessment and sale");
    expect(html).toContain("Five sheets not read yet");
    expect(html).toContain('action="/d/d-read/upgrade"');
    expect(html).toContain('action="/d/d-read/watch"');
    expect(html).toContain("SEPTA");
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("No screenshot was captured for this sheet.");
    expect(html).toContain("/evidence/d-read/licenses_inspections.jpg");
    expect(html).toContain("A report of what the official pages say, not a valuation and not advice.");
  });

  it("omits a figure whose sheet was not read, never as zero", async () => {
    await seedResolved("d-noprop", { statuses: { property: "error" }, errors: { property: "empty_content" } });
    const { html } = await page("/d/d-noprop");
    expect(html).not.toContain("assessed value, Office of Property Assessment");
    expect(html).not.toMatch(/<b>\$0<\/b>/);
    expect(html).toContain("CMX-5");
    expect(html).toContain("The page did not finish loading in four reads.");
  });

  it("shows Being read on pending sheets and a ten-second refresh", async () => {
    await seedResolved("d-partial", {
      status: "partial",
      statuses: { tax: "pending", flood: "pending", assessment_history: "skipped", schools: "skipped", li_deep: "skipped" },
    });
    const { res, html } = await page("/d/d-partial");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('http-equiv="refresh" content="10"');
    expect(html).toContain("Being read");
    expect(html).toContain("Department of Revenue");
  });

  it("renders no match with the typed text, what was tried, how to resolve, the atlas link and the form", async () => {
    await insertDossier(env.DB, {
      id: "d-nomatch",
      address_input: "99999 Nowhere St.",
      outcome: "no_match",
      tier: "free",
      status: "failed",
      added_by: "public",
      created_at: NOW,
      resolution_detail: {
        variants_tried: ["99999 Nowhere St.", "99999 NOWHERE ST"],
        manual_url: "https://atlas.phila.gov/",
        how_to_resolve: "Check the address or OPA account and try again.",
      },
    });
    const { html } = await page("/d/d-nomatch");
    expect(html).toContain("99999 Nowhere St.");
    expect(html).toContain("99999 NOWHERE ST");
    expect(html).toContain("Check the address or OPA account and try again.");
    expect(html).toContain("https://atlas.phila.gov/");
    expect(html).toContain('action="/go"');
    expect(html).not.toContain("$0");
  });

  it("renders ambiguous candidates as links that start a dossier", async () => {
    await insertDossier(env.DB, {
      id: "d-amb",
      address_input: "100 Market",
      outcome: "ambiguous",
      tier: "free",
      status: "failed",
      added_by: "public",
      created_at: NOW,
      resolution_detail: {
        candidates: [
          { address: "100 MARKET ST", url: "https://atlas.phila.gov/100%20MARKET%20ST/property" },
          { address: "100 MARKET AVE", url: "https://atlas.phila.gov/100%20MARKET%20AVE/property" },
        ],
        manual_url: "https://atlas.phila.gov/",
        how_to_resolve: "Choose the matching address and try again.",
      },
    });
    const { html } = await page("/d/d-amb");
    expect(html).toContain("100 MARKET ST");
    expect(html).toContain('name="address" value="100 MARKET ST"');
    expect(html).toContain("Choose the matching address and try again.");
  });

  it("prints a line under the title when a spelling was matched", async () => {
    await seedResolved("d-fuzzy", { resolution: "fuzzy", input: "1234 Markt St" });
    const { html } = await page("/d/d-fuzzy");
    expect(html).toContain("You typed 1234 Markt St. The city holds 1234 MARKET ST, PHILADELPHIA, PA 19107-3721.");
  });

  it("prints the building line and unit links when resolution is parent", async () => {
    await seedResolved("d-parent", {
      resolution: "parent",
      units: {
        count: 2,
        list: [
          { address: "UNIT 4B", opa_account: "222222222" },
          { address: "UNIT 5A", opa_account: "333333333" },
        ],
        list_url: "https://atlas.phila.gov/1234%20MARKET%20ST/condos",
      },
    });
    const { html } = await page("/d/d-parent");
    expect(html).toContain("This is the record of the whole building. It holds 2 units.");
    expect(html).toContain('name="address" value="222222222"');
    expect(html).toContain("UNIT 4B");
  });

  it("links the city's unit list when the list could not be read", async () => {
    await seedResolved("d-parent-nolist", {
      resolution: "parent",
      units: { count: 12, list: null, list_url: "https://atlas.phila.gov/1234%20MARKET%20ST/condos" },
    });
    const { html } = await page("/d/d-parent-nolist");
    expect(html).toContain("This is the record of the whole building. It holds 12 units.");
    expect(html).toContain("https://atlas.phila.gov/1234%20MARKET%20ST/condos");
  });

  it("prints a dossier's cost with its cents, so one dollar reads $1.00 and not $1", async () => {
    await seedResolved("d-cost", { spend: 1 });
    expect((await page("/d/d-cost")).html).toMatch(/Cost of this dossier<\/dt>\s*<dd>\$1\.00<\/dd>/);
    await seedResolved("d-cost2", { spend: 0.536 });
    expect((await page("/d/d-cost2")).html).toMatch(/Cost of this dossier<\/dt>\s*<dd>\$0\.536<\/dd>/);
  });

  it("says in plain words why a sheet could not be read, from a fixed list and never from stored text", async () => {
    await seedResolved("d-why", {
      statuses: { tax: "unavailable", assessment_history: "error", li_deep: "unavailable", schools: "error" },
      errors: { tax: "blocked", assessment_history: "unreadable_result", li_deep: "rows_not_read", schools: "agent_poll_failed" },
    });
    const { html } = await page("/d/d-why");
    expect(html).toContain("turned the automated browser away");
    expect(html).toContain("could not be read as a table");
    expect(html).toContain("their rows did not come back");
    expect(html).toContain("The read did not finish. It can be tried again.");
    expect(html).not.toContain("rows_not_read");
    expect(html).not.toContain("agent_poll_failed");
  });

  it("prints the generic unread sentence for a FEMA no-result gap, not the stored atlas words", async () => {
    await seedResolved("d-fema", {
      statuses: { flood: "unavailable" },
      errors: { flood: "FEMA's map search returned no results in an automated browser" },
    });
    const { html } = await page("/d/d-fema");
    expect(html).toContain('id="flood"');
    // Its own fixed sentence, in the page's words; the stored sentence is still not printed.
    expect(html).toContain("FEMA&#39;s map search gives an automated browser no result.");
    expect(html).not.toContain("FEMA's map search returned no results in an automated browser");
    expect(html).not.toContain("returned no results in an automated browser");
  });

  it("keeps a sheet that could not be read in order with the stored budget sentence", async () => {
    await seedResolved("d-budget", {
      statuses: { flood: "unavailable" },
      errors: { flood: "budget paused for public requests; the free core is complete" },
    });
    const { html } = await page("/d/d-budget");
    expect(html).toContain("id=\"flood\"");
    expect(html).toContain("budget paused for public requests; the free core is complete");
    expect(html).toContain("Check by hand");
  });

  it("uses the generic sentence for any other unread error", async () => {
    await seedResolved("d-gap", { statuses: { zoning: "error" }, errors: { zoning: "unrecognized_page" } });
    const { html } = await page("/d/d-gap");
    expect(html).toContain("The page could not be read.");
    expect(html).not.toContain("unrecognized_page");
  });

  it("renders the five Agent sheets when they have been read", async () => {
    await seedResolved("d-agent", {
      tier: "deep",
      statuses: {
        assessment_history: "ok",
        tax: "ok",
        flood: "ok",
        schools: "ok",
        li_deep: "ok",
      },
    });
    const { html } = await page("/d/d-agent");
    expect(html).toContain("Assessment history");
    expect(html).toContain("North Light School");
    expect(html).toContain("Real estate tax");
    expect(html).not.toContain("Five sheets not read yet");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("prints not stated for a missing field", async () => {
    await seedResolved("d-blank", { skipData: ["property"], statuses: { property: "ok" } });
    const { html } = await page("/d/d-blank");
    expect(html).toContain("not stated");
  });

  it("escapes hostile text in the address and in a city field", async () => {
    await seedResolved("d-xss", { hostileOwner: '<img src=x onerror="alert(1)">', input: "<script>alert(1)</script>" });
    const { html } = await page("/d/d-xss");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;img src=x onerror");
  });

  it("does not link a javascript URL from a city field", async () => {
    await seedResolved("d-js");
    const sections = await getSections(env.DB, "d-js");
    const zoning = sections.find((s) => s.section_id === "zoning")!;
    const data = zoning.data as Json;
    data.rcos = [{ name: "RCO", address: null, meeting_address: null, website: "javascript:alert(1)" }];
    await upsertSection(env.DB, "d-js", "zoning", { data: data as never });
    const { html } = await page("/d/d-js");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("shows the dossier note for a watched code and ignores a hostile note", async () => {
    await seedResolved("d-note");
    await env.DB.prepare(
      "INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by, expires_at) VALUES ('w1', ?, 'li', 'm1', 'active', 'public', '2026-11-16T17:34:00.000Z')",
    )
      .bind(OPA)
      .run();
    const { html } = await page("/d/d-note?note=watched");
    expect(html).toContain("This address is now watched until 16 Nov 2026.");
    const bad = await page("/d/d-note?note=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(bad.html).not.toContain("<script>alert(1)</script>");
  });

  it("answers 404 for an unknown dossier", async () => {
    expect((await callWorker("/d/nope")).status).toBe(404);
  });
});

describe("POST /d/:id/upgrade and /watch", () => {
  it("starts an upgrade and redirects with the started note", async () => {
    await seedResolved("d-up");
    const res = await formPost("/d/d-up/upgrade", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/d/d-up?note=started");
  });

  it("redirects with already when the sheets are already running or read", async () => {
    await seedResolved("d-up2", { tier: "standard", statuses: { assessment_history: "ok", tax: "ok", flood: "ok", schools: "ok", li_deep: "skipped" } });
    const res = await formPost("/d/d-up2/upgrade", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/d/d-up2?note=already");
  });

  it("respects the daily upgrade limit", async () => {
    await seedResolved("d-up3");
    await seedResolved("d-up4", { opa: "444444444" });
    expect((await formPost("/d/d-up3/upgrade", {})).headers.get("location")).toBe("/d/d-up3?note=started");
    const second = await formPost("/d/d-up4/upgrade", {});
    expect(second.headers.get("location")).toBe("/d/d-up4?note=limit");
  });

  it("redirects with budget when public Agent reads are paused", async () => {
    await seedResolved("d-up5");
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('b1', 'agent_step', 6, 'seed', ?)").bind(NOW).run();
    const res = await formPost("/d/d-up5/upgrade", {});
    expect(res.headers.get("location")).toBe("/d/d-up5?note=budget");
  });

  it("watches an address and redirects with the watched note", async () => {
    await seedResolved("d-w");
    fetchMock.intercept({
      method: "POST",
      url: "https://agent.tinyfish.ai/v1/monitors",
      reply: { status: 201, json: { monitor: { id: "mon-1" }, run: { id: "baseline", results: [{ text: fx("li-1234-market.md") }], errors: [] } } },
    });
    const res = await formPost("/d/d-w/watch", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/d/d-w?note=watched");
  });

  it("redirects with the day's limit when the visitor has already started a watch today", async () => {
    await seedResolved("d-w3");
    await seedResolved("d-w4", { opa: "444444444", resolved: "4001 WALNUT ST, PHILADELPHIA, PA 19104" });
    fetchMock.intercept({
      method: "POST",
      url: "https://agent.tinyfish.ai/v1/monitors",
      reply: { status: 201, json: { monitor: { id: "mon-1" }, run: { id: "baseline", results: [{ text: fx("li-1234-market.md") }], errors: [] } } },
    });
    expect((await formPost("/d/d-w3/watch", {})).headers.get("location")).toBe("/d/d-w3?note=watched");
    const second = await formPost("/d/d-w4/watch", {});
    expect(second.headers.get("location")).toBe("/d/d-w4?note=watch_limit");
    const { html } = await page("/d/d-w4?note=watch_limit");
    expect(html).toContain("One address a day can be watched from here. That number has been reached.");
  });

  it("redirects with no_slot when no public watch slot is left", async () => {
    await seedResolved("d-w2");
    for (let i = 0; i < 4; i++) {
      await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by) VALUES (?, ?, 'li', ?, 'active', 'public')")
        .bind(`slot${i}`, `opa${i}`, `m${i}`)
        .run();
    }
    const res = await formPost("/d/d-w2/watch", {});
    expect(res.headers.get("location")).toBe("/d/d-w2?note=no_slot");
  });
});

function expectPageShell(html: string, opts: { title: string; description: string; path: string }): void {
  expect(html).toContain(`<title>${opts.title}</title>`);
  expect(html).toContain(`<meta name="description" content="${opts.description}"/>`);
  expect(html).toContain(`<link rel="canonical" href="https://groundwork.test${opts.path}"/>`);
  expect(html).toContain(`<meta property="og:title" content="${opts.title}"/>`);
  expect(html).toContain(`<meta property="og:description" content="${opts.description}"/>`);
  expect(html).toContain(`<meta property="og:image" content="https://groundwork.test/assets/social.jpg"/>`);
  expect(html).toContain('<form class="ask" action="/go" method="post">');
}

describe("GET /watchlist", () => {
  it("renders the empty watchlist with the form and no public one-off lookup", async () => {
    await seedResolved("pub-one", {
      added_by: "public",
      input: "77 Invented Ave",
      resolved: "77 INVENTED AVE, PHILADELPHIA, PA 19103",
      opa: "111111111",
    });
    await insertEvent(env.DB, { opa_account: "111111111", kind: "sale", summary: "Invented sale at a private lookup", at: NOW });
    const { res, html } = await page("/watchlist");
    expect(res.status).toBe(200);
    expect(html).toContain("<h1>WATCHLIST</h1>");
    expect(html).toContain("Addresses TinyFish Monitor reads twice a day.");
    expectPageShell(html, {
      title: "Watchlist: Groundwork",
      description: "Addresses TinyFish Monitor reads twice a day.",
      path: "/watchlist",
    });
    expect(html).toContain("No address is watched yet. Open a dossier and choose Watch this address.");
    expect(html).toContain("No change has been recorded yet. Monitor reads each watched page twice a day.");
    expect(html).toContain(`0 of ${PUBLIC_WATCH_SLOTS}`);
    expect(html).not.toContain("77 Invented Ave");
    expect(html).not.toContain("Invented sale");
    expect(html).not.toContain('href="/d/pub-one"');
  });

  it("lists the watches we set for everyone, and a visitor's watch for that visitor only", async () => {
    const owner = await visitorHash(env, "203.0.113.40");
    await seedResolved("d-cur", { added_by: "curated" });
    await seedResolved("d-cur-newer", { added_by: "curated", opa: OPA });
    await seedResolved("d-visitor-same", { added_by: "public", opa: OPA, input: "typed by a visitor" });
    await seedResolved("d-pub-watch", {
      added_by: "public",
      input: "4001 Walnut St",
      resolved: "4001 WALNUT ST, PHILADELPHIA, PA 19104",
      opa: "222222222",
    });
    await seedResolved("d-oneoff", {
      added_by: "public",
      input: "77 Invented Ave",
      resolved: "77 INVENTED AVE, PHILADELPHIA, PA 19103",
      opa: "111111111",
    });
    await env.DB.prepare("UPDATE dossiers SET ip_hash = ? WHERE id = 'd-pub-watch'").bind(owner).run();
    await env.DB.prepare(
      "INSERT INTO parcels (opa_account, address_resolved, updated_at, li_checked_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
    )
      .bind(OPA, "1234 MARKET ST, PHILADELPHIA, PA 19107-3721", NOW, NOW, "222222222", "4001 WALNUT ST, PHILADELPHIA, PA 19104", NOW, NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by, last_applied_at) VALUES ('w-li', ?, 'li', 'm-li', 'active', 'curated', ?), ('w-prop', ?, 'property', 'm-prop', 'active', 'curated', ?)",
    )
      .bind(OPA, NOW, OPA, NOW)
      .run();
    await env.DB.prepare(
      "INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by, expires_at, owner_hash) VALUES ('w-pub', ?, 'li', 'm-pub', 'active', 'public', '2026-11-16T17:34:00.000Z', ?)",
    )
      .bind("222222222", owner)
      .run();
    await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES ('chk1', 'monitor_check', 0.005, 'monitor:m-li:r1', ?), ('chk2', 'monitor_check', 0.005, 'monitor:m-pub:r2', ?)")
      .bind(NOW, NOW)
      .run();
    await insertEvent(env.DB, { opa_account: OPA, kind: "new_permit", summary: "New permit at 1234 Market St", at: NOW });
    await insertEvent(env.DB, { opa_account: "222222222", kind: "new_permit", summary: "Invented permit at a visitor's watch", at: NOW });
    await insertEvent(env.DB, { opa_account: "111111111", kind: "sale", summary: "Invented sale at a private lookup", at: NOW });

    const { html } = await page("/watchlist");
    expect(html).toContain('href="/d/d-cur-newer"');
    expect(html).not.toContain('href="/d/d-visitor-same"');
    expect(html).toContain("1234 MARKET ST");
    expect(html).toContain("Licences and inspections");
    expect(html).toContain("Assessment and sale");
    expect(html).toContain("New permit at 1234 Market St");
    expect(html).toContain(`1 of ${PUBLIC_WATCH_SLOTS}`);
    expect(html).not.toContain("4001 WALNUT ST");
    expect(html).not.toContain("16 Nov 2026");
    expect(html).not.toContain('href="/d/d-pub-watch"');
    expect(html).not.toContain("Invented permit");
    expect(html).not.toContain("77 Invented Ave");
    expect(html).not.toContain("Invented sale");
    expect(html).not.toContain('href="/d/d-oneoff"');

    const another = await page("/watchlist", { headers: { "CF-Connecting-IP": "203.0.113.41" } });
    expect(another.html).not.toContain("4001 WALNUT ST");
    expect(another.html).not.toContain("Invented permit");

    const own = await page("/watchlist", { headers: { "CF-Connecting-IP": "203.0.113.40" } });
    expect(own.html).toContain("1234 MARKET ST");
    expect(own.html).toContain("4001 WALNUT ST");
    expect(own.html).toContain('href="/d/d-pub-watch"');
    expect(own.html).toContain("Yours until 16 Nov 2026");
    expect(own.html).toContain("Invented permit at a visitor&#39;s watch");
    expect(own.html).not.toContain("Invented sale");
  });

  it("escapes hostile text in a seeded watch address", async () => {
    await env.DB.prepare(
      "INSERT INTO parcels (opa_account, address_resolved) VALUES ('333333333', '<script>alert(1)</script>')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by) VALUES ('w-xss', '333333333', 'li', 'm-xss', 'active', 'curated')",
    ).run();
    const { html } = await page("/watchlist");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("GET /sources", () => {
  it("renders one sheet per office with how it is read, last success and the flood note", async () => {
    await seedResolved("d-src");
    const { res, html } = await page("/sources");
    expect(res.status).toBe(200);
    expect(html).toContain("<h1>NINE SOURCES</h1>");
    expect(html).toContain("Where every sheet comes from, and how it is read.");
    expect(html).not.toContain('<form class="ask"');
    expect(html).toContain(`<title>Nine sources: Groundwork</title>`);
    expect(html).toContain(`<link rel="canonical" href="https://groundwork.test/sources"/>`);
    expect(html).toContain(`<meta property="og:image" content="https://groundwork.test/assets/social.jpg"/>`);
    for (const a of SECTIONS) {
      expect(html).toContain(a.agency.replaceAll("&", "&amp;"));
      expect(html).toContain(a.label);
    }
    expect(html).toContain("Fetch at no cost");
    expect(html).toContain(`Agent, up to ${usd(AGENT_SECTION_MAX_USD)}`);
    expect(html).toContain(stamp(NOW));
    expect(html).toContain("not read yet");
    expect(html).toContain("map centre refuses automated access with the standard browser");
    expect(html).toContain("Groundwork does not get around that");
    expect(html).toContain("links the manual lookup");
    expect(html).toContain("https://msc.fema.gov/portal/search");
    expect(html).toContain("https://atlas.phila.gov/");
  });
});

describe("GET /about", () => {
  it("renders spend from the ledger, every public limit, every credit and the licence", async () => {
    await env.DB.prepare(
      `INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES
        ('f1', 'fetch', 0, 'a', ?),
        ('f2', 'fetch', 0, 'b', ?),
        ('a1', 'agent_step', 0.224, 'r1', ?),
        ('b1', 'screenshot', 0.002, 's1', ?),
        ('b2', 'screenshot', 0.002, 's2', ?),
        ('b3', 'screenshot', 0.002, 's3', ?),
        ('m1', 'monitor_check', 0.005, 'c1', ?)`,
    )
      .bind(NOW, NOW, NOW, NOW, NOW, NOW, NOW)
      .run();
    const { res, html } = await page("/about");
    expect(res.status).toBe(200);
    expect(html).toContain("<h1>ABOUT</h1>");
    expect(html).toContain("What Groundwork reads, what it costs and what it keeps.");
    expect(html).toContain("<h2>How TinyFish is used</h2>");
    expect(html).toContain("Fetch");
    expect(html).toContain("Agent");
    expect(html).toContain("Browser");
    expect(html).toContain("Monitor");
    expect(html).toContain(usd(0.224));
    expect(html).toContain(usd(0.006));
    expect(html).toContain(usd(0.005));
    expect(html).toContain(`<h2>Limits</h2>`);
    expect(html).toContain(String(PUBLIC_DOSSIERS_PER_IP_PER_DAY));
    expect(html).toContain(String(PUBLIC_UPGRADES_PER_IP_PER_DAY));
    expect(html).toContain(`A public visitor may start ${PUBLIC_WATCHES_PER_IP_PER_DAY} watch per UTC day.`);
    expect(html).toContain("A watch a visitor starts is listed for that visitor only.");
    expect(html).toContain(String(PUBLIC_WATCH_SLOTS));
    expect(html).toContain(String(PUBLIC_WATCH_TTL_DAYS));
    expect(html).toContain(String(MAX_MONITORS));
    expect(html).toContain(String(CURATED_ADDRESSES));
    expect(html).toContain(String(CACHE_HOURS));
    expect(html).toContain(String(PUBLIC_DOSSIER_TTL_DAYS));
    expect(html).toContain(String(FLOOD_RETRY_DAYS));
    expect(html).toContain(String(FETCH_RETRY_ON_LOADING));
    expect(html).toContain(String(FETCH_RETRY_DELAY_MS / 1000));
    expect(html).toContain(String(DEEP_ROWS_MAX));
    expect(html).toContain(usd(PUBLIC_AGENT_PAUSE_USD));
    expect(html).toContain(usd(SPEND_PAUSE_USD));
    expect(html).toContain(String(AGENT_MAX_STEPS));
    expect(html).toContain(String(AGENT_MAX_DURATION_SECONDS));
    expect(html).toContain(usd(AGENT_SECTION_MAX_USD));
    expect(html).toContain("salted hash");
    expect(html).toContain("One-off");
    expect(html).toContain('id="pictures"');
    for (const credit of credits) {
      expect(html).toContain(credit.title.replaceAll("&", "&amp;"));
      expect(html).toContain(credit.source);
      expect(html).toContain(credit.series);
      expect(html).toContain(credit.creator);
      expect(html).toContain(credit.license);
      expect(html).toContain(credit.via);
    }
    expect(html).toContain("/assets/captures/market-licences.jpg");
    expect(html).toContain("/assets/captures/market-deeds.jpg");
    expect(html).toContain("/assets/captures/germantown-assessment.jpg");
    expect(html).toContain("/assets/captures/germantown-zoning.jpg");
    expect(html).toContain("/assets/captures/walnut-zoning.jpg");
    expect(html).toContain("/assets/captures/walnut-assessment.jpg");
    expect(html).toContain("as they were read");
    expect(html).toContain("MIT");
    expect(html).toContain("Hamdan Esmail");
    expect(html).toContain('id="api"');
    expect(html).toContain("/api/dossiers/:id");
    expect(html).toContain("/api/sources");
    expect(html).toContain("/api/export.json");
    expect(html).toContain("/api/events");
    expect(html).toContain("/api/addresses/:opa/history");
    expect(html).toContain("/api/dossiers/:id/nearby");
    expect(html).toContain("/api/stats");
    // The routes that start something are listed too, with what a refusal looks like.
    expect(html).toContain("POST /api/dossiers");
    expect(html).toContain("POST /api/dossiers/:id/upgrade");
    expect(html).toContain("POST /api/dossiers/:id/retry");
    expect(html).toContain("{&quot;error&quot;: &quot;not_found&quot;}");
    expect(html).toContain(`<link rel="canonical" href="https://groundwork.test/about"/>`);
  });
});

describe("not found", () => {
  it("answers 404 with the form for an unknown page", async () => {
    const { res, html } = await page("/no-such-sheet");
    expect(res.status).toBe(404);
    expect(html).toContain("<h1>NO SUCH SHEET</h1>");
    expect(html).toContain("Nothing is filed at this address of the site.");
    expectPageShell(html, {
      title: "No such sheet: Groundwork",
      description: "Nothing is filed at this address of the site.",
      path: "/no-such-sheet",
    });
  });

  it("answers 404 with the form for an unknown dossier", async () => {
    const { res, html } = await page("/d/nope");
    expect(res.status).toBe(404);
    expect(html).toContain("<h1>NO SUCH SHEET</h1>");
    expect(html).toContain("Nothing is filed at this address of the site.");
    expect(html).toContain('<form class="ask" action="/go" method="post">');
    expect(html).toContain(`<link rel="canonical" href="https://groundwork.test/d/nope"/>`);
  });

  it("keeps JSON 404 for an unknown API path", async () => {
    const res = await callWorker("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("bar and footer links", () => {
  it("sends Watchlist, Sources, JSON API and All credits to real pages, and drops Source code", async () => {
    const { html } = await page("/");
    expect(html).toContain('href="/watchlist"');
    expect(html).toContain('href="/sources"');
    expect(html).toContain('href="/about#api"');
    expect(html).toContain('href="/about#pictures"');
    expect(html).not.toContain("Source code");
    expect(html).not.toContain('href="/api/export.json"');
    expect(html).toContain(`<meta property="og:image" content="https://groundwork.test/assets/social.jpg"/>`);
  });
});

describe("every page: its headers, its scripts and who built it", () => {
  const PAGES = ["/", "/watchlist", "/sources", "/about", "/d/d-every", "/d/d-every-nomatch", "/no-such-sheet"];

  beforeEach(async () => {
    await seedResolved("d-every");
    await insertDossier(env.DB, {
      id: "d-every-nomatch",
      address_input: "99999 Nowhere St.",
      outcome: "no_match",
      tier: "free",
      status: "failed",
      added_by: "public",
      created_at: NOW,
      resolution_detail: { variants_tried: ["99999 Nowhere St."], manual_url: "https://atlas.phila.gov/", how_to_resolve: "Check the address and try again." },
    });
  });

  it("sends a content security policy that allows no inline script, and loads only its own three scripts", async () => {
    for (const path of PAGES) {
      const { res, html } = await page(path);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("form-action 'self'");
      expect(csp, path).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(html.match(/<script[^>]*>/g), path).toEqual([
        '<script src="/assets/js-on.js">',
        '<script src="/assets/site.js" defer="">',
        '<script src="/assets/wait.js" defer="">',
      ]);
      expect(html, path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html, path).not.toMatch(/\son[a-z]+="/);
    }
  });

  it("names who built it in the footer of every page, with a link to his GitHub", async () => {
    for (const path of PAGES) {
      const { html } = await page(path);
      const footer = /<footer>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
      expect(footer, path).toContain('Built by <a href="https://github.com/HamdanEsmail" rel="author">Hamdan Esmail</a>');
      // The code is public, and every footer links it.
      expect(footer, path).toContain('<a href="https://github.com/HamdanEsmail/groundwork">GitHub</a>');
      expect(html, path).toContain('<meta name="author" content="Hamdan Esmail"/>');
    }
  });
});

describe("what a visitor sees while Groundwork works", () => {
  it("gives the address button its working words and a clock the page starts when it is pressed", async () => {
    await insertDossier(env.DB, {
      id: "d-wait-nomatch",
      address_input: "99999 Nowhere St.",
      outcome: "no_match",
      tier: "free",
      status: "failed",
      added_by: "public",
      created_at: NOW,
      resolution_detail: { variants_tried: ["99999 Nowhere St."], manual_url: "https://atlas.phila.gov/", how_to_resolve: "Check the address and try again." },
    });
    for (const path of ["/", "/watchlist", "/d/d-wait-nomatch", "/no-such-sheet"]) {
      const { html } = await page(path);
      const form = /<form class="ask" action="\/go" method="post">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
      expect(form, path).toMatch(/<button class="btn" type="submit" data-busy="Reading…">\s*Draw the dossier\s*<\/button>/);
      // Hidden until the button is pressed; the script then starts its clock.
      expect(form, path).toMatch(/<p class="wait-note" data-wait="true" hidden="">\s*<span class="clock num" data-since="">0:00<\/span> so far\. Reading the four city pages takes about 40 seconds\.\s*<\/p>/);
    }
  });

  it("shows how many sheets are read, a clock and the usual time while the rest are being read", async () => {
    await seedResolved("d-working", {
      tier: "standard",
      status: "partial",
      statuses: { assessment_history: "ok", tax: "pending", flood: "pending", schools: "pending", li_deep: "skipped" },
    });
    const started = new Date(Date.now() - 135_000).toISOString();
    await env.DB.prepare("UPDATE dossiers SET workflow_started_at = ? WHERE id = 'd-working'").bind(started).run();
    const { html } = await page("/d/d-working");
    expect(html).toContain('http-equiv="refresh" content="10"');
    // Four free sheets and one of the four Agent sheets are read: 5 of the 8 asked for.
    expect(html).toContain('<progress class="meter" value="5" max="8">5 of 8</progress>');
    expect(html).toMatch(/5 of 8 sheets done\. <span class="clock num" data-since="[^"]+">2:1\d<\/span> so far\. Each of the sheets still to read takes up to 3 minutes\. This page refreshes itself\./);

    // A dossier with nothing left to read shows no bar and no clock.
    await seedResolved("d-done", { opa: "555555555" });
    const done = (await page("/d/d-done")).html;
    expect(done).not.toContain('class="meter"');
    expect(done).not.toContain("data-since");
  });

  it("gives the other buttons their working words", async () => {
    await seedResolved("d-buttons");
    const { html } = await page("/d/d-buttons");
    expect(html).toMatch(/action="\/d\/d-buttons\/watch"><button class="btn quiet" type="submit" data-busy="Starting the watch…">/);
    expect(html).toMatch(/action="\/d\/d-buttons\/upgrade"><button class="btn" type="submit" data-busy="Starting…">/);
  });
});
