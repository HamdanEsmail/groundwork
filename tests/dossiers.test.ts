import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SECTION_MAX_USD, FETCH_RETRY_DELAY_MS, FETCH_RETRY_ON_LOADING } from "../src/core/limits";
import { PRICES } from "../src/core/spend";
import { getDossier, insertDossier } from "../src/db/dossiers";
import { today } from "../src/db/publicUse";
import { getSections, upsertSection } from "../src/db/sections";
import type { Dossier, StoredSection } from "../src/db/types";
import { runDossierSections } from "../src/dossier/agentSteps";
import { createDossier } from "../src/dossier/build";
import { buildDeps } from "../src/dossier/deps";
import { toDossierDocument } from "../src/dossier/document";
import { dossierStatus } from "../src/dossier/status";
import { SECTIONS } from "../src/sections/index";
import type { SectionId, SectionStatus } from "../src/sections/types";
import worker from "../src/index";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fx(name: string): string {
  const text = fixtures[`./fixtures/atlas/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}`);
  return text;
}

const FETCH_API = "https://api.fetch.tinyfish.ai";
const BASE = "https://groundwork.test";
const OPA = "883309050";
const tabUrl = (address: string, tab: string) => `https://atlas.phila.gov/${encodeURIComponent(address)}/${tab}`;

const SHEET_ORDER: SectionId[] = [
  "property",
  "zoning",
  "licenses_inspections",
  "deeds",
  "assessment_history",
  "tax",
  "flood",
  "schools",
  "li_deep",
];
const FREE: SectionId[] = ["property", "zoning", "licenses_inspections", "deeds"];
const STANDARD_AGENT: SectionId[] = ["assessment_history", "tax", "schools", "flood"];
const AGENT: SectionId[] = [...STANDARD_AGENT, "li_deep"];

// --- atlas mock: every TinyFetch call is one POST; route on the atlas URL in the body -------------

const EMPTY = Symbol("empty_content");
const HTTP_500 = Symbol("http_500");
type Answer = string | typeof EMPTY | typeof HTTP_500;

const unrouted: string[] = [];
function mockAtlas(routes: Record<string, Answer | Answer[]>): void {
  const queues = new Map(Object.entries(routes).map(([url, a]) => [url, Array.isArray(a) ? [...a] : [a]]));
  fetchMock.intercept({
    method: "POST",
    url: FETCH_API,
    times: Infinity,
    reply: (_req, body) => {
      const url = (body as { urls: string[] }).urls[0]!;
      const queue = queues.get(url);
      if (!queue) {
        unrouted.push(url);
        throw new Error(`test has no answer for ${url}`);
      }
      const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (answer === HTTP_500) return Response.json({ error: { code: "internal_error", message: "boom" } }, { status: 500 });
      if (answer === EMPTY) {
        const miss = JSON.parse(fx("property-empty.json")) as { errors: { url: string }[] };
        miss.errors[0]!.url = url;
        return Response.json(miss);
      }
      return Response.json({ results: [{ url, final_url: url, title: "Atlas", text: answer }], errors: [] });
    },
  });
}

/** The atlas URLs asked for, in order. */
function requested(): string[] {
  return fetchMock.calls.filter((c) => c.url === `${FETCH_API}/`).map((c) => (c.body as { urls: string[] }).urls[0]!);
}

const STREET = "1234 MARKET ST";
type Tab = "property" | "li" | "zoning" | "deeds";
/** 1234 Market St as recorded: /property at the raw input, the other three tabs at the H1 street. */
function market(input = "1234 Market St", overrides: Partial<Record<Tab, Answer | Answer[]>> = {}): Record<string, Answer | Answer[]> {
  return {
    [tabUrl(input, "property")]: overrides.property ?? fx("property-1234-market.md"),
    [tabUrl(STREET, "li")]: overrides.li ?? fx("li-1234-market.md"),
    [tabUrl(STREET, "zoning")]: overrides.zoning ?? fx("zoning-1234-market.md"),
    [tabUrl(STREET, "deeds")]: overrides.deeds ?? fx("deeds-1234-market.md"),
  };
}

// --- screenshot and Workflow seams ------------------------------------------------------------------

const shots: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
const jpeg = (url: string) => {
  const bytes = new Uint8Array(12_000);
  bytes.set(new TextEncoder().encode(`\xff\xd8 jpeg of ${url}`));
  return bytes.buffer;
};
function mockShots(fail: (url: string) => boolean = () => false) {
  return vi.spyOn(buildDeps, "screenshotFullPage").mockImplementation(async (_env, url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    shots.push(url);
    if (fail(url)) throw new TypeError("socket closed");
    return { bytes: jpeg(url), height: 800, sessionId: "s", settled: true };
  });
}

type WorkflowCreateArg = { id: string; params: { dossierId: string; sections: string[]; evidence?: boolean } };
async function executeEvidenceWorkflow(
  opts?: { id?: string; params?: { dossierId: string; sections: string[]; evidence?: boolean } },
) {
  const params = opts?.params;
  if (params?.evidence && params.sections.length === 0) {
    await runDossierSections(env, params, {
      async do(_name: string, _config: object, callback: () => Promise<string | void>) {
        await callback();
      },
      async sleep() {},
    });
  }
  return {} as Awaited<ReturnType<typeof env.DOSSIER_WORKFLOW.create>>;
}
let workflowCreate: ReturnType<typeof vi.spyOn>;
function createdWorkflows(): WorkflowCreateArg[] {
  return (workflowCreate.mock.calls as unknown as [WorkflowCreateArg][]).map(([arg]) => arg);
}
function evidenceCreates(): WorkflowCreateArg[] {
  return createdWorkflows().filter((c) => c.params.evidence);
}
function agentCreates(): WorkflowCreateArg[] {
  return createdWorkflows().filter((c) => c.params.sections.length > 0);
}

beforeEach(async () => {
  fetchMock.activate();
  unrouted.length = 0;
  shots.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dossiers"),
    env.DB.prepare("DELETE FROM sections"),
    env.DB.prepare("DELETE FROM public_use"),
    env.DB.prepare("DELETE FROM spend"),
    env.DB.prepare("DELETE FROM parcels"),
  ]);
  const listed = await env.STORE.list({ prefix: "evidence/" });
  if (listed.objects.length > 0) await env.STORE.delete(listed.objects.map((o) => o.key));
  mockShots();
  workflowCreate = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockImplementation(executeEvidenceWorkflow);
});

afterEach(() => {
  fetchMock.reset();
  vi.restoreAllMocks();
  expect(unrouted).toEqual([]);
});

// --- request helpers ------------------------------------------------------------------------------

interface Caller {
  admin?: boolean;
  ip?: string;
}

async function post(path: string, body: unknown, who: Caller = {}): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": who.ip ?? "203.0.113.7" };
  if (who.admin) headers.Authorization = "Bearer test-admin";
  const res = await callWorker(path, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const create = (body: unknown, who: Caller = {}) => post("/api/dossiers", body, who);
const upgrade = (id: string, who: Caller = {}) => post(`/api/dossiers/${id}/upgrade`, {}, who);

async function getDoc(id: string): Promise<{ status: number; body: Json }> {
  const res = await callWorker(`/api/dossiers/${id}`);
  return { status: res.status, body: await res.json() };
}

async function seedSpend(amount: number): Promise<void> {
  await env.DB.prepare("INSERT INTO spend (id, kind, amount_usd, ref, at) VALUES (?, 'agent_step', ?, 'seed', ?)")
    .bind(crypto.randomUUID(), amount, new Date().toISOString())
    .run();
}

async function dossierCount(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM dossiers").first<{ n: number }>())!.n;
}

function statusOf(sections: StoredSection[]): Record<string, SectionStatus> {
  return Object.fromEntries(sections.map((s) => [s.section_id, s.status]));
}

/** A public free dossier for 1234 Market St, built through the API. */
async function publicMarket(ip = "203.0.113.7"): Promise<string> {
  mockAtlas(market());
  const res = await create({ address: "1234 Market St" }, { ip });
  expect(res.status).toBe(202);
  fetchMock.reset();
  fetchMock.activate();
  return res.body.dossier_id as string;
}

// --- POST /api/dossiers: a public free dossier --------------------------------------------------------

describe("POST /api/dossiers (public, free)", () => {
  it("reads the four atlas tabs, skips the Agent sections with an upgrade price, stores four screenshots and completes", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St" });

    expect(res.status).toBe(202);
    const id = res.body.dossier_id as string;
    expect(res.body).toEqual({
      dossier_id: id,
      status: "complete",
      outcome: "resolved",
      cached: false,
      tier: "free",
      estimated_cost_usd: 0.008,
      report_url: `${BASE}/d/${id}`,
    });
    // /property is read once (by the resolver); the other three tabs at the H1 street
    expect(requested().sort()).toEqual(
      [tabUrl("1234 Market St", "property"), tabUrl(STREET, "li"), tabUrl(STREET, "zoning"), tabUrl(STREET, "deeds")].sort(),
    );

    const sections = await getSections(env.DB, id);
    expect(statusOf(sections)).toEqual({
      property: "ok",
      zoning: "ok",
      licenses_inspections: "ok",
      deeds: "ok",
      assessment_history: "skipped",
      tax: "skipped",
      flood: "skipped",
      schools: "skipped",
      li_deep: "skipped",
    });
    for (const s of sections.filter((r) => FREE.includes(r.section_id as SectionId))) {
      expect(s.method).toBe("fetch");
      expect(s.evidence_key).toBe(`evidence/${id}/${s.section_id}.jpg`);
      expect(s.spend_usd).toBe(PRICES.screenshot);
      expect(s.error).toBeNull();
      expect(s.checked_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(s.data).not.toBeNull();
    }
    for (const s of sections.filter((r) => AGENT.includes(r.section_id as SectionId))) {
      expect(s.method).toBe("agent");
      expect(s.data).toBeNull();
      expect(s.evidence_key).toBeNull();
    }

    // four evidence objects, one per free section, as JPEG
    const listed = await env.STORE.list({ prefix: `evidence/${id}/` });
    expect(listed.objects.map((o) => o.key).sort()).toEqual(FREE.map((s) => `evidence/${id}/${s}.jpg`).sort());
    const object = await env.STORE.get(`evidence/${id}/property.jpg`);
    expect(object?.httpMetadata?.contentType).toBe("image/jpeg");
    // screenshots of the URLs read, one after another
    expect(shots.sort()).toEqual(FREE.map((s) => SECTIONS.find((a) => a.id === s)!.url({ address: STREET, opa: OPA })).sort());
    expect(maxInFlight).toBe(1);

    const dossier = (await getDossier(env.DB, id))!;
    expect(dossier).toMatchObject({
      status: "complete",
      tier: "free",
      outcome: "resolved",
      resolution: "exact",
      added_by: "public",
      opa_account: OPA,
      address_input: "1234 Market St",
      address_resolved: "1234 MARKET ST, PHILADELPHIA, PA 19107-3721",
      spend_usd: 0.008,
      cached_from: null,
      workflow_id: null,
    });
    expect(dossier.completed_at).not.toBeNull();
    expect(dossier.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const ttl = Date.parse(dossier.expires_at!) - Date.parse(dossier.created_at);
    expect(ttl).toBe(7 * 24 * 3_600_000);
    expect(agentCreates()).toEqual([]);
    expect(evidenceCreates()).toHaveLength(1);
    expect(evidenceCreates()[0]!.params).toEqual({ dossierId: id, sections: [], evidence: true });
    expect(evidenceCreates()[0]!.id).toMatch(new RegExp(`^${id}-ev-[0-9a-f]{8}$`));
    expect(dossier.workflow_id).toBeNull();
    expect(dossier.workflow_started_at).toBeNull();
  });

  it("serves the dossier document: nine sections, nine sources in sheet order, evidence URLs and the next tier", async () => {
    const id = await publicMarket();
    const { status, body } = await getDoc(id);
    expect(status).toBe(200);

    expect(Object.keys(body.sections)).toEqual(SHEET_ORDER);
    expect(body.sources.map((s: Json) => s.id)).toEqual(SHEET_ORDER);
    expect(body).toMatchObject({
      dossier_id: id,
      status: "complete",
      has_errors: false,
      tier: "free",
      spend_usd: 0.008,
      cached: false,
      cached_from: null,
      watch: null,
      report_url: `${BASE}/d/${id}`,
      json_url: `${BASE}/api/dossiers/${id}`,
      address: {
        input: "1234 Market St",
        resolved: "1234 MARKET ST, PHILADELPHIA, PA 19107-3721",
        opa_account: OPA,
        resolution: "exact",
        units: null,
      },
      next_tier: {
        tier: "standard",
        adds: ["Assessment history", "Real estate tax", "Catchment schools", "Flood zone"],
        cost_usd: 0.896,
      },
    });
    expect(body.address).not.toHaveProperty("resolved_to");
    expect(body).not.toHaveProperty("resolution_detail");
    expect(body.created_at).toMatch(/Z$/);
    expect(body.completed_at).toMatch(/Z$/);

    const property = body.sections.property;
    expect(property).toEqual({
      status: "ok",
      label: "Assessment and sale",
      source: "Office of Property Assessment",
      source_url: tabUrl(STREET, "property"),
      checked_at: expect.stringMatching(/Z$/),
      method: "fetch",
      evidence_url: `${BASE}/evidence/${id}/property.jpg`,
      data: expect.objectContaining({ opa_account: OPA, owners: ["SEPTA"], assessed_value_usd: 148232900, sale_date: "1993-09-17" }),
    });
    expect(body.sections.licenses_inspections).toMatchObject({
      status: "ok",
      source: "Department of Licenses & Inspections",
      source_url: tabUrl(STREET, "li"),
      evidence_url: `${BASE}/evidence/${id}/licenses_inspections.jpg`,
      depth: "recent",
      rows_returned: null,
      truncated: null,
      data: { permits: { count: 155 }, violations: { count: 83, open_count: 4 } },
    });
    expect(body.sections.zoning.data.base_district).toBe("CMX-5");
    expect(body.sections.deeds.data.map_registry).toBe("001S070144");

    const ctx = { address: STREET, opa: OPA };
    for (const sid of AGENT) {
      const adapter = SECTIONS.find((a) => a.id === sid)!;
      expect(body.sections[sid]).toEqual({
        status: "skipped",
        label: adapter.label,
        source: adapter.agency,
        source_url: adapter.url(ctx),
        checked_at: null,
        method: "agent",
        evidence_url: null,
        data: null,
        manual_url: adapter.manualUrl?.(ctx) ?? adapter.url(ctx),
        upgrade_cost_usd: AGENT_SECTION_MAX_USD,
      });
    }
    expect(body.sections.flood.manual_url).toBe("https://msc.fema.gov/portal/search?AddressQuery=1234%20MARKET%20ST%2C%20Philadelphia%2C%20PA");
    expect(body.sections.li_deep.source_url).toBe("https://li.phila.gov/property-history/search?address=1234%20MARKET%20ST");

    const sheet = SECTIONS.map((a) => ({
      id: a.id,
      agency: a.agency,
      label: a.label,
      url: body.sections[a.id].source_url,
      checked_at: body.sections[a.id].checked_at,
      status: body.sections[a.id].status,
      method: a.method,
    }));
    expect(body.sources).toEqual(sheet);
  });

  it.each([
    ["1234 market st."],
    ["1234 Market St Philadelphia PA 19107"],
  ])("resolves %j to OPA 883309050 through the API", async (input) => {
    mockAtlas({ ...market(input, { property: EMPTY }), [tabUrl(STREET, "property")]: fx("property-1234-market.md") });
    const sleeps: number[] = [];
    const created = await createDossier(env, { address: input }, { admin: false, ipHash: "h-focus1" }, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(created.outcome).toBe("resolved");
    const { body } = await getDoc(created.dossierId);
    expect(body.address).toMatchObject({ input, opa_account: OPA, resolution: "exact", resolved: "1234 MARKET ST, PHILADELPHIA, PA 19107-3721" });
    // The text as typed is read once; its empty answer is a miss, so the cleaned form follows with no wait.
    expect(requested().slice(0, 2)).toEqual([tabUrl(input, "property"), tabUrl(STREET, "property")]);
    expect(sleeps).toEqual([]);
  });

  it("resolves a condominium parent (1500 Market St) to the parent parcel with its units", async () => {
    const as1500 = (text: string) => text.replaceAll("1234 MARKET ST", "1500 MARKET ST").replaceAll("19107-3721", "19102-2100");
    mockAtlas({
      [tabUrl("1500 Market St", "property")]: fx("property-1500-market.md"),
      [tabUrl("1500 Market St", "condos")]: fx("condos-1500-market.md"),
      [tabUrl("1500 MARKET ST", "li")]: as1500(fx("li-1234-market.md")),
      [tabUrl("1500 MARKET ST", "zoning")]: as1500(fx("zoning-1234-market.md")),
      [tabUrl("1500 MARKET ST", "deeds")]: as1500(fx("deeds-1234-market.md")),
    });
    const res = await create({ address: "1500 Market St" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ outcome: "resolved", status: "complete" });
    const { body } = await getDoc(res.body.dossier_id);
    expect(body.address).toEqual({
      input: "1500 Market St",
      resolved: "1500 MARKET ST, PHILADELPHIA, PA 19102-2100",
      opa_account: "883320000",
      resolution: "parent",
      units: {
        count: 2,
        list: [
          { address: "1500-42 MARKET ST", opa_account: "883320000" },
          { address: "1500S MARKET ST", opa_account: "875100060" },
        ],
        list_url: tabUrl("1500 Market St", "condos"),
        kind: "condominium_units",
      },
    });
    expect(body.sections.property.data.units_notice).toBe(2);
  });

  it("marks the dossier a parent when zoning or deeds count several active parcels", async () => {
    const several = fx("zoning-1234-market.md").replace("There is 1 active parcel at this address", "There are 3 active parcels at this address");
    mockAtlas(market("1234 Market St", { zoning: several }));
    const res = await create({ address: "1234 Market St" });
    const { body } = await getDoc(res.body.dossier_id);
    expect(body.address.resolution).toBe("parent");
    expect(body.address.units).toEqual({ count: 3, list: null, list_url: null, kind: "active_parcels" });
  });

  it("records a fuzzy match with resolved_to", async () => {
    mockAtlas(market("1234 Markt St"));
    const res = await create({ address: "1234 Markt St" });
    const { body } = await getDoc(res.body.dossier_id);
    expect(body.address).toMatchObject({ resolution: "fuzzy", resolved_to: "1234 MARKET ST, PHILADELPHIA, PA 19107-3721" });
  });

  it("looks an OPA account up and builds the same dossier", async () => {
    mockAtlas({ ...market(OPA) });
    const res = await create({ opa_account: OPA });
    expect(res.status).toBe(202);
    const { body } = await getDoc(res.body.dossier_id);
    expect(body.address).toMatchObject({ input: OPA, opa_account: OPA, resolution: "exact" });
    expect(statusOf(await getSections(env.DB, res.body.dossier_id)).deeds).toBe("ok");
  });

  it("coerces a public standard or deep request to free and reports the requested tier", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St", tier: "deep" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ tier: "free", requested_tier: "deep", estimated_cost_usd: 0.008, status: "complete" });
    expect(agentCreates()).toEqual([]);
    expect(evidenceCreates()).toHaveLength(1);
    expect((await getDossier(env.DB, res.body.dossier_id))!.tier).toBe("free");
  });

  it("ignores curated: true from a public caller", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St", curated: true });
    expect((await getDossier(env.DB, res.body.dossier_id))!.added_by).toBe("public");
  });

  it("stores the callback_url for an admin and refuses it from a public caller", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St", callback_url: "https://example.test/hook" }, { admin: true });
    expect((await getDossier(env.DB, res.body.dossier_id))!.callback_url).toBe("https://example.test/hook");
    mockAtlas(market());
    const refused = await create({ address: "1234 Market St", callback_url: "https://example.test/hook" });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: "invalid_input", detail: expect.stringMatching(/admin token/i) });
  });
});

// --- section statuses ------------------------------------------------------------------------------------

describe("free section statuses", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  it("stores an /li read still incomplete after the retries as error incomplete_after_retries, never as data", async () => {
    sleeps.length = 0;
    mockAtlas(market("1234 Market St", { li: fx("li-loading.md") }));
    const created = await createDossier(env, { address: "1234 Market St" }, { admin: false, ipHash: "h-loading" }, { sleep });

    expect(requested().filter((u) => u === tabUrl(STREET, "li"))).toHaveLength(4);
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS, FETCH_RETRY_DELAY_MS]);
    const sections = await getSections(env.DB, created.dossierId);
    const li = sections.find((s) => s.section_id === "licenses_inspections")!;
    expect(li).toMatchObject({ status: "error", error: "incomplete_after_retries", data: null, evidence_key: null, method: "fetch" });
    expect(li.source_url).toBe(tabUrl(STREET, "li"));
    // no screenshot of a page that was not read
    expect(shots).not.toContain(tabUrl(STREET, "li"));
    expect(shots).toHaveLength(3);

    const dossier = (await getDossier(env.DB, created.dossierId))!;
    expect(dossier.status).toBe("complete");
    expect(dossier.spend_usd).toBe(0.006);
    const { body } = await getDoc(created.dossierId);
    expect(body.has_errors).toBe(true);
    expect(body.sections.licenses_inspections).toMatchObject({
      status: "error",
      reason: "incomplete_after_retries",
      data: null,
      evidence_url: null,
      manual_url: tabUrl(STREET, "li"),
    });
  });

  it("stores a page the parser does not recognise as error unrecognized_page", async () => {
    mockAtlas(market("1234 Market St", { zoning: fx("shell-licenses-inspections.md") }));
    const res = await create({ address: "1234 Market St" });
    const sections = await getSections(env.DB, res.body.dossier_id);
    expect(sections.find((s) => s.section_id === "zoning")).toMatchObject({ status: "error", error: "unrecognized_page", data: null });
    expect(res.body.status).toBe("complete");
  });

  it("stores a fetch failure as error with the error code", async () => {
    const sleeps: number[] = [];
    mockAtlas(market("1234 Market St", { deeds: HTTP_500 }));
    const created = await createDossier(env, { address: "1234 Market St" }, { admin: false, ipHash: "h-500" }, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const { body } = await getDoc(created.dossierId);
    expect(body.sections.deeds).toMatchObject({ status: "error", reason: "internal_error", data: null });
    expect(body.has_errors).toBe(true);
    expect(body.status).toBe("complete");
    expect(sleeps).toHaveLength(FETCH_RETRY_ON_LOADING);
  });

  it("stores an /li section after empty_content then a complete read", async () => {
    const sleeps: number[] = [];
    mockAtlas(market("1234 Market St", { li: [EMPTY, fx("li-1234-market.md")] }));
    const created = await createDossier(env, { address: "1234 Market St" }, { admin: false, ipHash: "h-empty-ok" }, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const li = (await getSections(env.DB, created.dossierId)).find((s) => s.section_id === "licenses_inspections")!;
    expect(li).toMatchObject({ status: "ok", error: null });
    expect(sleeps).toEqual([FETCH_RETRY_DELAY_MS]);
  });

  it("stores empty_content when every /li read is empty", async () => {
    const sleeps: number[] = [];
    mockAtlas(market("1234 Market St", { li: EMPTY }));
    const created = await createDossier(env, { address: "1234 Market St" }, { admin: false, ipHash: "h-empty-err" }, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const li = (await getSections(env.DB, created.dossierId)).find((s) => s.section_id === "licenses_inspections")!;
    expect(li).toMatchObject({ status: "error", error: "empty_content", data: null });
    expect(sleeps).toHaveLength(FETCH_RETRY_ON_LOADING);
  });

  it("stores an /li page that lists nothing as empty", async () => {
    const nothing = [
      "# 1234 MARKET ST",
      "",
      "PHILADELPHIA, PA 19107-3721",
      "",
      "## Permits (0)",
      "",
      "## Zoning Permit Documents (0)",
      "",
      "## Inspections (0)",
      "",
      "## Violations (0)",
      "",
    ].join("\n");
    mockAtlas(market("1234 Market St", { li: nothing }));
    const res = await create({ address: "1234 Market St" });
    const sections = await getSections(env.DB, res.body.dossier_id);
    const li = sections.find((s) => s.section_id === "licenses_inspections")!;
    expect(li.status).toBe("empty");
    expect(li.data).toMatchObject({ permits: { count: 0, recent: [] } });
    // an empty section is screenshotted like an ok one
    expect(li.evidence_key).toBe(`evidence/${res.body.dossier_id}/licenses_inspections.jpg`);
  });

  it("keeps a section's status when its screenshot fails, with no evidence and no charge for a refused session", async () => {
    vi.mocked(buildDeps.screenshotFullPage).mockRestore();
    workflowCreate.mockRestore();
    workflowCreate = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockImplementation(executeEvidenceWorkflow);
    mockShots((url) => url.endsWith("/zoning"));
    mockAtlas(market());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await create({ address: "1234 Market St" });
    const sections = await getSections(env.DB, res.body.dossier_id);
    const zoning = sections.find((s) => s.section_id === "zoning")!;
    expect(zoning).toMatchObject({ status: "ok", evidence_key: null });
    expect(sections.filter((s) => s.evidence_key !== null)).toHaveLength(3);
    // the failure came after the session was made (not a TinyFishError), so it was billed
    expect((await getDossier(env.DB, res.body.dossier_id))!.spend_usd).toBe(0.008);
    // only the error's name is logged
    expect(errors.mock.calls.flat().join(" ")).toContain("TypeError");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("socket closed");
  });

  it("skips every screenshot once total spend reaches the spend pause", async () => {
    await seedSpend(8);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockAtlas(market());
    const res = await create({ address: "1234 Market St" });
    expect(res.status).toBe(202);
    expect(shots).toEqual([]);
    const sections = await getSections(env.DB, res.body.dossier_id);
    expect(sections.every((s) => s.evidence_key === null)).toBe(true);
    expect(statusOf(sections).property).toBe("ok");
    expect((await getDossier(env.DB, res.body.dossier_id))!.spend_usd).toBe(0);
  });
});

// --- failed resolution, atlas errors, input ------------------------------------------------------------

describe("resolution failures and input", () => {
  it("answers no_match with 200 and a failed dossier row that keeps the variants tried", async () => {
    mockAtlas({
      [tabUrl("99999 Nowhere St.", "property")]: fx("property-no-record.md"),
      [tabUrl("99999 NOWHERE ST", "property")]: fx("property-no-record.md"),
    });
    const res = await create({ address: "99999 Nowhere St." });
    expect(res.status).toBe(200);
    const id = res.body.dossier_id as string;
    expect(res.body).toEqual({
      dossier_id: id,
      status: "failed",
      outcome: "no_match",
      variants_tried: ["99999 Nowhere St.", "99999 NOWHERE ST"],
      manual_url: "https://atlas.phila.gov/",
      how_to_resolve: "Check the address or OPA account and try again.",
      report_url: `${BASE}/d/${id}`,
    });
    expect(shots).toEqual([]);
    const dossier = (await getDossier(env.DB, id))!;
    expect(dossier).toMatchObject({ status: "failed", outcome: "no_match", opa_account: null, address_input: "99999 Nowhere St." });
    expect(dossier.resolution_detail).toEqual({
      variants_tried: ["99999 Nowhere St.", "99999 NOWHERE ST"],
      manual_url: "https://atlas.phila.gov/",
      how_to_resolve: res.body.how_to_resolve,
    });
    expect(await getSections(env.DB, id)).toEqual([]);

    const { body } = await getDoc(id);
    expect(body).toMatchObject({ status: "failed", has_errors: false, next_tier: null, resolution_detail: dossier.resolution_detail });
    expect(Object.keys(body.sections)).toEqual(SHEET_ORDER);
    expect(body.sections.property).toMatchObject({ status: "unavailable", reason: "address_not_resolved", data: null, source_url: null, manual_url: null });
    expect(body.sources).toHaveLength(9);
  });

  it("answers 502 atlas_unavailable when the atlas cannot be read, writes no row and gives the daily slot back", async () => {
    mockAtlas({ [tabUrl("1234 Market St", "property")]: HTTP_500 });
    const err = await createDossier(env, { address: "1234 Market St" }, { admin: false, ipHash: "h-502" }, {
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 502,
      body: { error: "atlas_unavailable", code: "internal_error", manual_url: "https://atlas.phila.gov/" },
    });
    expect(await dossierCount()).toBe(0);
    const rows = await env.DB.prepare("SELECT dossiers FROM public_use").all<{ dossiers: number }>();
    expect(rows.results.map((r) => r.dossiers)).toEqual([0]);
  });

  it("answers no_match at once when the address has no house number", async () => {
    const res = await create({ address: "market st" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_match",
      variants_tried: ["market st"],
      how_to_resolve: "Include the house number, for example 1234 Market St, or use the 9-digit OPA account.",
    });
    expect(requested()).toEqual([]);
    expect(await dossierCount()).toBe(1);
  });

  it("still returns the dossier when the evidence Workflow cannot be created", async () => {
    workflowCreate.mockRejectedValueOnce(new Error("workflows down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAtlas(market());
    const res = await create({ address: "1234 Market St" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "complete", outcome: "resolved" });
    expect((await getDossier(env.DB, res.body.dossier_id))!.workflow_id).toBeNull();
    expect(shots).toEqual([]);
    expect(logged.mock.calls.flat().map(String).join(" ")).toContain("Error");
    expect(logged.mock.calls.flat().map(String).join(" ")).not.toContain("workflows down");
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["neither address nor opa_account", {}],
    ["both address and opa_account", { address: "1234 Market St", opa_account: OPA }],
    ["an empty address", { address: "   " }],
    ["an address over 200 characters", { address: "1".repeat(201) }],
    ["a non-string address", { address: 1234 }],
    ["an OPA account that is not 9 digits", { opa_account: "88330905" }],
    ["an OPA account as a number", { opa_account: 883309050 }],
    ["an unknown tier", { address: "1234 Market St", tier: "gold" }],
    ["a non-boolean fresh", { address: "1234 Market St", fresh: "yes" }],
    ["an http callback_url", { address: "1234 Market St", callback_url: "http://example.test/hook" }],
    ["a callback_url that is not a URL", { address: "1234 Market St", callback_url: "https://" }],
    ["a non-string unit", { address: "1234 Market St", unit: 4 }],
    ["a non-boolean curated", { address: "1234 Market St", curated: "yes" }],
    ["an unknown field", { address: "1234 Market St", color: "red" }],
  ])("rejects %s with 400 invalid_input and counts nothing", async (_label, body) => {
    const res = await create(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_input", detail: expect.any(String) });
    expect(fetchMock.calls).toEqual([]);
    expect(await dossierCount()).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_use").first<{ n: number }>())!.n).toBe(0);
  });
});

// --- public cap and cache --------------------------------------------------------------------------------

describe("public cap and the 24-hour cache", () => {
  it("refuses the fourth public create from one IP with 429, counting no_match and cache hits", async () => {
    mockAtlas({
      ...market(),
      [tabUrl("99999 Nowhere St", "property")]: fx("property-no-record.md"),
      [tabUrl("99999 NOWHERE ST", "property")]: fx("property-no-record.md"),
    });
    const ip = "198.51.100.4";
    expect((await create({ address: "1234 Market St" }, { ip })).status).toBe(202);
    expect((await create({ address: "1234 Market St" }, { ip })).body.cached).toBe(true);
    expect((await create({ address: "99999 Nowhere St" }, { ip })).status).toBe(200);
    const before = fetchMock.calls.length;
    const fourth = await create({ address: "1234 Market St" }, { ip });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual({ error: "rate_limited", limit: 3 });
    expect(fetchMock.calls.length).toBe(before);
    // another visitor is not affected; the admin has no cap
    expect((await create({ address: "1234 Market St" }, { ip: "198.51.100.5" })).status).toBe(202);
    expect((await create({ address: "1234 Market St" }, { ip, admin: true })).status).toBe(202);
  });

  it("answers a second create within 24 hours from the cache: a new row with copied sections, cached: true, no TinyFish call", async () => {
    const first = await publicMarket("192.0.2.1");
    mockAtlas({ [tabUrl("1234 Market Street", "property")]: fx("property-1234-market.md") });
    const second = await create({ address: "1234 Market Street" }, { ip: "192.0.2.2" });

    expect(second.status).toBe(202);
    const id = second.body.dossier_id as string;
    expect(id).not.toBe(first);
    expect(second.body).toEqual({
      dossier_id: id,
      status: "complete",
      outcome: "resolved",
      cached: true,
      tier: "free",
      estimated_cost_usd: 0,
      report_url: `${BASE}/d/${id}`,
    });
    // only the resolver's /property read; no tab read, no screenshot
    expect(requested()).toEqual([tabUrl("1234 Market Street", "property")]);
    expect(shots).toHaveLength(4);

    const original = await getSections(env.DB, first);
    const copied = await getSections(env.DB, id);
    const strip = (rows: StoredSection[]) => rows.map(({ dossier_id: _d, ...rest }) => rest);
    expect(strip(copied)).toEqual(strip(original));
    const copy = (await getDossier(env.DB, id))!;
    const orig = (await getDossier(env.DB, first))!;
    expect(copy).toMatchObject({
      cached_from: first,
      status: "complete",
      tier: "free",
      completed_at: orig.completed_at,
      spend_usd: 0,
      added_by: "public",
      address_input: "1234 Market Street",
      opa_account: OPA,
    });
    expect(copy.ip_hash).not.toBe(orig.ip_hash);
    expect(copy.expires_at).not.toBeNull();

    const { body } = await getDoc(id);
    expect(body).toMatchObject({ cached: true, cached_from: first, spend_usd: 0 });
    expect(body.sections.property.evidence_url).toBe(`${BASE}/evidence/${first}/property.jpg`);
  });

  it("rebuilds on fresh: true", async () => {
    const first = await publicMarket("192.0.2.1");
    mockAtlas(market());
    const res = await create({ address: "1234 Market St", fresh: true }, { ip: "192.0.2.3" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ cached: false, estimated_cost_usd: 0.008 });
    expect(res.body.dossier_id).not.toBe(first);
    expect(requested()).toHaveLength(4);
    expect(shots).toHaveLength(8);
    expect((await getDossier(env.DB, res.body.dossier_id))!.cached_from).toBeNull();
  });

  it("returns a running dossier's own id for a cache hit that is still partial, without a new row", async () => {
    mockAtlas(market());
    const first = await create({ address: "1234 Market St" }, { admin: true });
    expect(first.body.status).toBe("partial");
    const rows = await dossierCount();
    const second = await create({ address: "1234 Market St" }, { admin: true });
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ dossier_id: first.body.dossier_id, status: "partial", cached: true, estimated_cost_usd: 0, tier: "standard" });
    expect(await dossierCount()).toBe(rows);
    // One Workflow for each of the four standard sections, from the first request only.
    expect(agentCreates()).toHaveLength(4);
    expect(evidenceCreates()).toHaveLength(1);
  });

  it("does not answer a standard request from a free dossier", async () => {
    await publicMarket("192.0.2.1");
    mockAtlas(market());
    const res = await create({ address: "1234 Market St" }, { admin: true });
    expect(res.body).toMatchObject({ cached: false, tier: "standard" });
  });
});

// --- admin tiers --------------------------------------------------------------------------------------------

describe("admin tiers", () => {
  it("builds standard by default: four Agent sections pending, one Workflow each, li_deep skipped", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St" }, { admin: true });
    expect(res.status).toBe(202);
    const id = res.body.dossier_id as string;
    expect(res.body).toMatchObject({ status: "partial", tier: "standard", estimated_cost_usd: 0.904, cached: false });
    expect(res.body).not.toHaveProperty("requested_tier");

    expect(evidenceCreates()).toHaveLength(1);
    expect(agentCreates().map((c) => c.params)).toEqual(STANDARD_AGENT.map((s) => ({ dossierId: id, sections: [s] })));
    for (const c of agentCreates()) expect(c.id).toMatch(new RegExp(`^${id}-${c.params.sections[0]}-[0-9a-f]{8}$`));
    const arg = agentCreates()[0]!;
    expect(evidenceCreates()[0]!.id).toMatch(new RegExp(`^${id}-ev-[0-9a-f]{8}$`));

    const dossier = (await getDossier(env.DB, id))!;
    expect(dossier).toMatchObject({ status: "partial", tier: "standard", added_by: "admin", workflow_id: arg.id, completed_at: null, expires_at: null, ip_hash: null });
    expect(dossier.workflow_started_at).not.toBeNull();
    const statuses = statusOf(await getSections(env.DB, id));
    for (const s of STANDARD_AGENT) expect(statuses[s]).toBe("pending");
    expect(statuses.li_deep).toBe("skipped");

    const { body } = await getDoc(id);
    expect(body.sections.tax).toMatchObject({ status: "pending", method: "agent", source_url: "https://tax-services.phila.gov/_/" });
    expect(body.sections.tax).not.toHaveProperty("upgrade_cost_usd");
    expect(body.sections.li_deep).toMatchObject({ status: "skipped", upgrade_cost_usd: AGENT_SECTION_MAX_USD });
    expect(body.next_tier).toEqual({ tier: "deep", adds: ["Permit and violation history"], cost_usd: 0.224 });
  });

  it("builds deep with all five Agent sections, one Workflow each", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St", tier: "deep", curated: true }, { admin: true });
    expect(res.body).toMatchObject({ status: "partial", tier: "deep", estimated_cost_usd: 1.128 });
    expect(agentCreates().map((c) => c.params.sections)).toEqual(AGENT.map((s) => [s]));
    const statuses = statusOf(await getSections(env.DB, res.body.dossier_id));
    for (const s of AGENT) expect(statuses[s]).toBe("pending");
    const dossier = (await getDossier(env.DB, res.body.dossier_id))!;
    expect(dossier.added_by).toBe("curated");
    const { body } = await getDoc(res.body.dossier_id);
    expect(body.next_tier).toBeNull();
  });

  it("builds an admin free dossier when asked", async () => {
    mockAtlas(market());
    const res = await create({ address: "1234 Market St", tier: "free" }, { admin: true });
    expect(res.body).toMatchObject({ status: "complete", tier: "free", estimated_cost_usd: 0.008 });
    expect(agentCreates()).toEqual([]);
    expect(evidenceCreates()).toHaveLength(1);
  });

  it("finishes the free core and marks the Agent sections error when the Workflow cannot be started", async () => {
    workflowCreate.mockRejectedValueOnce(new Error("workflows down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockAtlas(market());
    const res = await create({ address: "1234 Market St" }, { admin: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "complete", estimated_cost_usd: 0.008 });
    const sections = await getSections(env.DB, res.body.dossier_id);
    for (const s of STANDARD_AGENT) expect(sections.find((r) => r.section_id === s)).toMatchObject({ status: "error", error: "workflow_start_failed" });
    expect((await getDossier(env.DB, res.body.dossier_id))!.workflow_id).toBeNull();
  });
});

// --- POST /api/dossiers/:id/upgrade ---------------------------------------------------------------------------

describe("POST /api/dossiers/:id/upgrade", () => {
  it("refuses a public upgrade with 503 budget_paused once spend reaches $6, without using the daily upgrade", async () => {
    const id = await publicMarket();
    workflowCreate.mockClear();
    await seedSpend(6);
    const res = await upgrade(id);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "budget_paused", reason: "budget paused for public requests; the free core is complete" });
    expect(workflowCreate).not.toHaveBeenCalled();
    expect(statusOf(await getSections(env.DB, id)).tax).toBe("skipped");
    const dossier = (await getDossier(env.DB, id))!;
    expect(dossier).toMatchObject({ tier: "free", status: "complete" });
    expect((await today(env.DB, dossier.ip_hash!)).upgrades).toBe(0);
  });

  it("starts the Workflow for an admin upgrade at the same spend", async () => {
    const id = await publicMarket();
    workflowCreate.mockClear();
    await seedSpend(6);
    const res = await upgrade(id, { admin: true });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ dossier_id: id, status: "partial", estimated_cost_usd: 0.896, sections: STANDARD_AGENT });
    expect(workflowCreate).toHaveBeenCalledTimes(4);
    expect(createdWorkflows().map((c) => c.params)).toEqual(STANDARD_AGENT.map((s) => ({ dossierId: id, sections: [s] })));
    const arg = workflowCreate.mock.calls[0]![0] as { id: string; params: unknown };
    const dossier = (await getDossier(env.DB, id))!;
    expect(dossier).toMatchObject({ tier: "standard", status: "partial", workflow_id: arg.id, completed_at: null });
    const statuses = statusOf(await getSections(env.DB, id));
    for (const s of STANDARD_AGENT) expect(statuses[s]).toBe("pending");
    expect(statuses.li_deep).toBe("skipped");
    expect(statuses.property).toBe("ok");
  });

  it("lets a public visitor upgrade once a day (429 on the second)", async () => {
    const a = await publicMarket("203.0.113.9");
    mockAtlas(market());
    const b = (await create({ address: "1234 Market St", fresh: true }, { ip: "203.0.113.9" })).body.dossier_id as string;
    workflowCreate.mockClear();
    expect((await upgrade(a, { ip: "203.0.113.9" })).status).toBe(202);
    const second = await upgrade(b, { ip: "203.0.113.9" });
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: "rate_limited", limit: 1 });
    // The first upgrade started its four sections; the refused one started nothing.
    expect(workflowCreate).toHaveBeenCalledTimes(4);
    expect(statusOf(await getSections(env.DB, b)).tax).toBe("skipped");
    // another visitor still can
    expect((await upgrade(b, { ip: "203.0.113.10" })).status).toBe(202);
  });

  it("gives the daily upgrade back and restores the free dossier when the Workflow cannot be started", async () => {
    const id = await publicMarket();
    const before = (await getDossier(env.DB, id))!;
    workflowCreate.mockClear();
    workflowCreate.mockRejectedValueOnce(new Error("workflows down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await upgrade(id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "workflow_start_failed" });
    const after = (await getDossier(env.DB, id))!;
    expect(after).toMatchObject({ tier: "free", status: "complete", completed_at: before.completed_at, workflow_id: null });
    expect(statusOf(await getSections(env.DB, id)).tax).toBe("skipped");
    expect((await today(env.DB, before.ip_hash!)).upgrades).toBe(0);
    // and the slot works afterwards
    expect((await upgrade(id)).status).toBe(202);
  });

  it("answers 404 for an unknown or failed dossier and 409 for one already upgraded", async () => {
    expect(await upgrade("no-such-dossier")).toEqual({ status: 404, body: { error: "not_found" } });
    const failed = await insertDossier(env.DB, { tier: "free", status: "failed", added_by: "public", outcome: "no_match" });
    expect((await upgrade(failed)).status).toBe(404);

    const id = await publicMarket();
    expect((await upgrade(id, { admin: true })).status).toBe(202);
    const again = await upgrade(id, { admin: true });
    expect(again).toEqual({ status: 409, body: { error: "already_upgraded" } });

    mockAtlas(market());
    const standard = (await create({ address: "1234 Market St", fresh: true }, { admin: true })).body.dossier_id as string;
    expect((await upgrade(standard, { admin: true })).status).toBe(409);
  });
});

// --- GET /api/dossiers/:id and the document ---------------------------------------------------------------------

describe("GET /api/dossiers/:id", () => {
  it("answers 404 not_found for an unknown id", async () => {
    expect(await getDoc("nope")).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("reports the deep read's depth on licenses_inspections once it has finished", () => {
    const now = "2026-11-03T12:00:00.000Z";
    const dossier: Dossier = {
      id: "d1",
      address_input: "1234 Market St",
      address_resolved: "1234 MARKET ST, PHILADELPHIA, PA 19107-3721",
      opa_account: OPA,
      unit: null,
      resolution: "exact",
      outcome: "resolved",
      tier: "deep",
      status: "complete",
      cached_from: null,
      ip_hash: null,
      added_by: "admin",
      created_at: now,
      completed_at: now,
      spend_usd: 1,
      expires_at: null,
      workflow_id: "w",
      workflow_started_at: now,
      callback_url: null,
      units: null,
      resolution_detail: null,
    };
    const row = (section_id: SectionId, status: SectionStatus, extra: Partial<StoredSection> = {}): StoredSection => ({
      dossier_id: "d1",
      section_id,
      status,
      method: FREE.includes(section_id) ? "fetch" : "agent",
      source_url: `https://example.test/${section_id}`,
      checked_at: now,
      evidence_key: null,
      data: null,
      raw_key: null,
      run_id: null,
      error: null,
      spend_usd: 0,
      rows_returned: null,
      depth: null,
      ...extra,
    });
    const sections = SHEET_ORDER.map((s) =>
      s === "licenses_inspections" ? row(s, "ok", { depth: "extended", rows_returned: 100 }) : s === "flood" ? row(s, "unavailable", { error: "no results" }) : row(s, "ok"),
    );
    const doc = toDossierDocument(dossier, sections, "https://groundwork.test/") as Json;
    expect(doc.sections.licenses_inspections).toMatchObject({ depth: "extended", rows_returned: 100, truncated: true });
    expect(doc.sections.flood).toMatchObject({ status: "unavailable", reason: "no results", manual_url: "https://msc.fema.gov/portal/search?AddressQuery=1234%20MARKET%20ST%2C%20Philadelphia%2C%20PA" });
    expect(doc.json_url).toBe("https://groundwork.test/api/dossiers/d1");
    // The sheets that were asked for and not read are named at the top, and each says why in words.
    expect(doc.gaps).toEqual(["flood"]);
    expect(doc.sections.flood.reason_text).toBe("The page could not be read.");
    expect(doc.next_tier).toBeNull();

    const full = toDossierDocument(dossier, sections.map((s) => (s.section_id === "licenses_inspections" ? { ...s, depth: "full" as const } : s)), "https://groundwork.test") as Json;
    expect(full.sections.licenses_inspections.truncated).toBe(false);
    const watched = toDossierDocument(dossier, sections, "https://groundwork.test", { watch: { watch_id: "w1", monitors: ["li"] } }) as Json;
    expect(watched.watch).toEqual({ watch_id: "w1", monitors: ["li"] });
  });

  it("shows a section a running dossier has not written yet as pending", async () => {
    const id = await insertDossier(env.DB, {
      tier: "free",
      status: "partial",
      added_by: "admin",
      outcome: "resolved",
      resolution: "exact",
      opa_account: OPA,
      address_resolved: "1234 MARKET ST, PHILADELPHIA, PA 19107-3721",
    });
    await upsertSection(env.DB, id, "property", { status: "ok", method: "fetch", data: { opa_account: OPA } });
    const { body } = await getDoc(id);
    expect(body.sections.property.status).toBe("ok");
    expect(body.sections.zoning).toMatchObject({ status: "pending", data: null, source_url: tabUrl(STREET, "zoning") });
  });
});

// --- dossier status rule --------------------------------------------------------------------------------------------

describe("dossierStatus", () => {
  const rows = (statuses: Partial<Record<SectionId, SectionStatus>>) =>
    Object.entries(statuses).map(([section_id, status]) => ({ section_id, status: status as SectionStatus }));
  const free4 = (s: SectionStatus) => ({ property: s, zoning: s, licenses_inspections: s, deeds: s });
  const skippedAgents = { assessment_history: "skipped", tax: "skipped", flood: "skipped", schools: "skipped", li_deep: "skipped" } as const;

  it("is partial while any section is pending", () => {
    expect(dossierStatus("standard", rows({ ...free4("ok"), ...skippedAgents, tax: "pending" }))).toEqual({ status: "partial", hasErrors: false });
  });

  it("is complete when every section is terminal, with hasErrors when one errored", () => {
    expect(dossierStatus("free", rows({ ...free4("ok"), ...skippedAgents }))).toEqual({ status: "complete", hasErrors: false });
    expect(dossierStatus("free", rows({ ...free4("ok"), deeds: "error", ...skippedAgents }))).toEqual({ status: "complete", hasErrors: true });
    expect(dossierStatus("standard", rows({ ...free4("empty"), ...skippedAgents, flood: "unavailable", tax: "ok", schools: "ok", assessment_history: "ok" }))).toEqual({
      status: "complete",
      hasErrors: false,
    });
  });

  it("is failed only when every requested section errored; skipped sections are not requested", () => {
    expect(dossierStatus("free", rows({ ...free4("error"), ...skippedAgents }))).toEqual({ status: "failed", hasErrors: true });
    expect(dossierStatus("standard", rows({ ...free4("error"), ...skippedAgents, tax: "error", schools: "error", flood: "error", assessment_history: "error" }))).toEqual({
      status: "failed",
      hasErrors: true,
    });
    expect(dossierStatus("standard", rows({ ...free4("error"), ...skippedAgents, tax: "ok", schools: "error", flood: "error", assessment_history: "error" }))).toEqual({
      status: "complete",
      hasErrors: true,
    });
  });
});

// --- GET /evidence/* -----------------------------------------------------------------------------------------------

describe("GET /evidence/*", () => {
  it("serves a stored screenshot with its type and a one-day cache", async () => {
    const id = await publicMarket();
    const res = await callWorker(`/evidence/${id}/zoning.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(jpeg(tabUrl(STREET, "zoning"))));
  });

  it("answers 404 for a missing object", async () => {
    const res = await callWorker("/evidence/nope/property.jpg");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it.each(["/evidence/a/..%2F..%2Fsecret", "/evidence/a%5Cb.jpg", "/evidence/", "/evidence/%E0%A4%A"])("rejects %s", async (path) => {
    await env.STORE.put("secret", "x");
    const res = await callWorker(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_key" });
  });
});

// --- a visitor who leaves while the city is being read ---------------------------------------------

describe("a request whose client goes away", () => {
  it("hands the build to waitUntil, so the platform lets it finish and no dossier is left half read", async () => {
    mockAtlas({
      [tabUrl("99999 Nowhere St.", "property")]: fx("property-no-record.md"),
      [tabUrl("99999 NOWHERE ST", "property")]: fx("property-no-record.md"),
    });
    const inner = createExecutionContext();
    const kept: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        kept.push(p);
        inner.waitUntil(p);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    for (const [path, init] of [
      ["/api/dossiers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "99999 Nowhere St." }) }],
      ["/go", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "address=99999+Nowhere+St." }],
    ] as const) {
      kept.length = 0;
      const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
      await waitOnExecutionContext(inner);
      expect(res.status, path).toBeLessThan(400);
      expect(kept.length, path).toBeGreaterThan(0);
    }
  });
});
