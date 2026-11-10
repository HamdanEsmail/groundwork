import changedFixture from "./fixtures/webhooks/li-changed.json";
import reorderedFixture from "./fixtures/webhooks/li-reordered.json";
import loadingFixture from "./fixtures/webhooks/li-loading.json";
import saleFixture from "./fixtures/webhooks/property-sale.json";
import { visitorHash } from "../src/auth";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import { parseLi } from "../src/sections/li";
import { parseProperty } from "../src/sections/property";
import { getParcelSection, upsertParcelSection } from "../src/db/parcels";
import { getSections, upsertSection } from "../src/db/sections";
import { PUBLIC_WATCHES_PER_IP_PER_DAY } from "../src/core/limits";

const fixtures = import.meta.glob("./fixtures/atlas/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const fx = (name: string) => fixtures[`./fixtures/atlas/${name}`]!;
const post = (path: string, body: unknown) => callWorker(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const MONITORS = "https://agent.tinyfish.ai/v1/monitors";
const monitorAnswers = (id: string) => fetchMock.intercept({ method: "POST", url: MONITORS, reply: { status: 201, json: { monitor: { id }, run: { id: "baseline", results: [{ text: fx("li-1234-market.md") }], errors: [] } } } });
const watchAs = (dossierId: string, ip: string) => callWorker(`/api/dossiers/${dossierId}/watch`, { method: "POST", headers: { "CF-Connecting-IP": ip } });
const payload = (text: string, id = "run-1", monitor = "mon-1") => ({ id, fetch_monitor_id: monitor, outcome: "changed", results: [{ text }], errors: [] });
beforeEach(async () => {
  fetchMock.activate();
  await env.DB.batch(["events", "watches", "parcels", "sections", "dossiers", "spend", "monitor_processing", "public_use"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d1','883309050','1234 MARKET ST','resolved','free','complete','public','2026-11-01T00:00:00.000Z',0)").run();
});
afterEach(() => fetchMock.reset());

describe("watches and Monitor webhooks", () => {
  it("creates a public L&I monitor with a baseline and refuses duplicate watches", async () => {
    fetchMock.intercept({method: "POST", url: "https://agent.tinyfish.ai/v1/monitors", reply: {status: 201, json: {monitor: {id: "mon-1"}, run: {id: "baseline", results: [{text: fx("li-1234-market.md")}], errors: []}}}});
    const res = await post("/api/dossiers/d1/watch", {});
    expect(res.status).toBe(201);
    const body = await res.json() as {monitors: unknown[]};
    expect(body.monitors).toHaveLength(1);
    expect((await post("/api/dossiers/d1/watch", {})).status).toBe(409);
    expect(fetchMock.calls).toHaveLength(1);
  });
  it("rejects bad secrets and malformed bodies", async () => {
    expect((await post("/hooks/monitor/wrong", {})).status).toBe(404);
    expect((await post("/hooks/monitor/test-secret", {fetch_monitor_id: 12})).status).toBe(400);
  });
  it("diffs changed rows, ignores incomplete and reordered pages, and delivers one callback", async () => {
    await upsertParcelSection(env.DB, "883309050", "licenses_inspections", parseLi(fx("li-1234-market.md"))!, "1234 MARKET ST");
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status, callback_url) VALUES ('w','883309050','li','mon-1','active','https://callback.test/hook')").run();
    const log=vi.spyOn(console,"warn").mockImplementation(()=>{});
    expect((await post("/hooks/monitor/test-secret", payload(fx("li-loading.md"), "loading"))).status).toBe(200);
    expect(log).toHaveBeenCalledWith("incomplete monitor read"); log.mockRestore();
    expect((await post("/hooks/monitor/test-secret", payload(fx("li-1234-market-reordered.md") + "\nChecked at 2026-11-09T12:00:00Z\n", "reorder"))).status).toBe(200);
    fetchMock.intercept({method: "POST", url: "https://callback.test/hook", reply: {status: 200}});
    expect((await post("/hooks/monitor/test-secret", payload(fx("li-1234-market-changed.md")))).status).toBe(200);
    const {results} = await env.DB.prepare("SELECT kind, rows FROM events ORDER BY kind").all<{kind:string;rows:string}>();
    expect(results.map(r => r.kind)).toEqual(["new_permit", "violation_closed"]);
    expect(results.every(r => JSON.parse(r.rows).length > 0)).toBe(true);
    expect(fetchMock.calls).toHaveLength(1);
  });
  it("records property sale before and after", async () => {
    const text = fx("property-1234-market.md");
    await upsertParcelSection(env.DB, "883309050", "property", parseProperty(text)!);
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status) VALUES ('w','883309050','property','mon-1','active')").run();
    const changed = text.replace("09/17/1993", "09/17/2026");
    expect(changed).not.toBe(text);
    await post("/hooks/monitor/test-secret", payload(changed));
    const row = await env.DB.prepare("SELECT kind, before, after FROM events").first<{kind:string; before:string; after:string}>();
    expect(row?.kind).toBe("sale"); expect(row?.before).toBeTruthy(); expect(row?.after).toBeTruthy();
  });
  it("exports only curated or watched dossiers and finds nearby watched events", async () => {
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d2','2','1250 MARKET ST','resolved','free','complete','admin','2026-11-01T00:00:00.000Z',0), ('d3','3','1300 MARKET ST','resolved','free','complete','admin','2026-11-01T00:00:00.000Z',0)").run();
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by) VALUES ('w','2','li','m','active','admin'),('w3','3','li','m3','active','admin')").run();
    await env.DB.prepare("INSERT INTO parcels (opa_account,address_resolved) VALUES ('2','1250 MARKET ST'),('3','1300 MARKET ST')").run();
    await env.DB.prepare("INSERT INTO events (id, opa_account, kind, at) VALUES ('e','2','new_permit','2026-11-01T00:00:00.000Z'),('e2','3','sale','2026-11-01T00:00:00.000Z')").run();
    const exported = await (await callWorker("/api/export.json")).json() as {dossiers: {dossier_id:string}[]};
    expect(exported.dossiers.map(d => d.dossier_id).sort()).toEqual(["d2", "d3"]);
    const nearby = await (await callWorker("/api/dossiers/d1/nearby")).json() as {events: {id:string}[]};
    expect(nearby.events.map(e => e.id)).toEqual(["e"]);
  });
  it("creates both admin monitors and enforces the global and public caps", async () => {
    for (const [id,text] of [["m1",fx("li-1234-market.md")],["m2",fx("property-1234-market.md")]]) fetchMock.intercept({method:"POST",url:"https://agent.tinyfish.ai/v1/monitors",reply:{status:201,json:{monitor:{id},run:{id:"base",results:[{text}],errors:[]}}}});
    const res=await callWorker("/api/dossiers/d1/watch",{method:"POST",headers:{authorization:"Bearer test-admin"}});
    expect(res.status).toBe(201); expect(fetchMock.calls).toHaveLength(2);
    await env.DB.prepare("DELETE FROM watches").run();
    for(let i=0;i<4;i++) await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by) VALUES (?,?, 'li',?,'active','public')").bind(`w${i}`,`opa${i}`,`m${i}`).run();
    expect((await post("/api/dossiers/d1/watch",{})).status).toBe(409);
    await env.DB.prepare("DELETE FROM watches").run();
    for(let i=0;i<10;i++) await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by) VALUES (?,?, 'li',?,'active','admin')").bind(`w${i}`,`opa${i}`,`m${i}`).run();
    expect((await post("/api/dossiers/d1/watch",{})).status).toBe(409);
  });
  it("keeps failed monitor deletion active and counted", async () => {
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by) VALUES ('w','883309050','li','m','active','public')").run();
    fetchMock.intercept({method:"DELETE",url:"https://agent.tinyfish.ai/v1/monitors/m",reply:{status:500}});
    const res=await callWorker("/api/dossiers/d1/watch",{method:"DELETE",headers:{authorization:"Bearer test-admin"}});
    expect(res.status).toBe(502);
    expect((await env.DB.prepare("SELECT status FROM watches WHERE id='w'").first<{status:string}>())?.status).toBe("active");
  });
  it("counts an unchanged check once and ignores unknown monitors", async () => {
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status) VALUES ('w','883309050','li','mon-1','active')").run();
    const data={id:"unchanged",fetch_monitor_id:"mon-1",outcome:"unchanged"};
    expect((await post("/hooks/monitor/test-secret",data)).status).toBe(200);
    expect((await post("/hooks/monitor/test-secret",data)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM spend").first<{n:number}>())?.n).toBe(1);
    expect((await post("/hooks/monitor/test-secret",{...data,fetch_monitor_id:"stranger"})).status).toBe(404);
  });

  it("does not let another visitor remove a public watch for the same parcel", async () => {
    const first = await visitorHash(env,"192.0.2.1"), second = await visitorHash(env,"192.0.2.2");
    await env.DB.prepare("UPDATE dossiers SET ip_hash=? WHERE id='d1'").bind(first).run();
    fetchMock.intercept({method:"POST",url:"https://agent.tinyfish.ai/v1/monitors",reply:{status:201,json:{monitor:{id:"m1"},run:{id:"base",results:[{text:fx("li-1234-market.md")}],errors:[]}}}});
    const created=await callWorker("/api/dossiers/d1/watch",{method:"POST",headers:{"CF-Connecting-IP":"192.0.2.1"}}); expect(created.status).toBe(201);
    await env.DB.prepare("INSERT INTO dossiers (id,opa_account,address_resolved,outcome,tier,status,added_by,created_at,spend_usd,ip_hash) VALUES ('other','883309050','1234 MARKET ST','resolved','free','complete','public','2026-11-01T00:00:00.000Z',0,?)").bind(second).run();
    const removed=await callWorker("/api/dossiers/other/watch",{method:"DELETE",headers:{"CF-Connecting-IP":"192.0.2.2"}});
    expect(removed.status).toBe(403);
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("does not advance parcel memory when event storage fails", async () => {
    const initial=parseLi(fx("li-1234-market.md"))!;
    await upsertParcelSection(env.DB,"883309050","licenses_inspections",initial);
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status) VALUES ('w','883309050','li','mon-1','active')").run();
    await env.DB.prepare("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'test failure'); END").run();
    try { expect((await post("/hooks/monitor/test-secret",payload(fx("li-1234-market-changed.md")))).status).toBe(500); }
    finally { await env.DB.prepare("DROP TRIGGER fail_event").run(); }
    const row=await env.DB.prepare("SELECT last_section_data FROM parcels WHERE opa_account='883309050'").first<{last_section_data:string}>();
    expect(JSON.parse(row!.last_section_data).licenses_inspections).toEqual(initial);
  });

  it("uses the previous L&I read time after an intervening property update",async()=>{
    const li=fx("li-1234-market.md"), property=fx("property-1234-market.md");
    await upsertParcelSection(env.DB,"883309050","licenses_inspections",parseLi(li)!);
    await env.DB.prepare("UPDATE parcels SET li_checked_at='2026-10-01T00:00:00.000Z' WHERE opa_account='883309050'").run();
    await upsertParcelSection(env.DB,"883309050","property",parseProperty(property)!);
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status) VALUES ('w','883309050','li','mon-1','active')").run();
    await post("/hooks/monitor/test-secret",payload(li));
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE kind='certification_expired'").first<{n:number}>())?.n).toBe(1);
  });

  it("reads events, parcel history, and all nine sources",async()=>{
    await env.DB.prepare("UPDATE dossiers SET added_by='admin' WHERE id='d1'").run();
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by) VALUES ('w','883309050','li','mon-1','active','admin')").run();
    await upsertParcelSection(env.DB,"883309050","property",parseProperty(fx("property-1234-market.md"))!,"1234 MARKET ST");
    await env.DB.prepare("INSERT INTO events (id,opa_account,kind,at) VALUES ('event','883309050','sale','2026-11-01T00:00:00.000Z')").run();
    const events=await (await callWorker("/api/events?address=1234%20MARKET%20ST&since=2026-10-01")).json() as {events:{id:string}[]};
    expect(events.events.map(e=>e.id)).toEqual(["event"]);
    expect((await callWorker("/api/events?since=invalid")).status).toBe(400);
    const history=await (await callWorker("/api/addresses/883309050/history")).json() as {dossiers:{dossier_id:string}[];events:{id:string}[]};
    expect(history.dossiers[0]?.dossier_id).toBe("d1"); expect(history.events[0]?.id).toBe("event");
    const sources=await (await callWorker("/api/sources")).json() as {sources:{id:string}[]};
    expect(sources.sources).toHaveLength(9); expect(sources.sources.some(x=>x.id==="li_deep")).toBe(true);
  });

  it("hides one-off public lookups from history and events; an admin token sees them", async () => {
    await upsertParcelSection(env.DB, "883309050", "property", parseProperty(fx("property-1234-market.md"))!, "1234 MARKET ST");
    await env.DB.prepare("INSERT INTO events (id,opa_account,kind,at) VALUES ('event','883309050','sale','2026-11-01T00:00:00.000Z')").run();
    expect(await (await callWorker("/api/addresses/883309050/history")).json()).toEqual({ dossiers: [], events: [] });
    expect(await (await callWorker("/api/events?address=1234%20MARKET%20ST")).json()).toEqual({ events: [] });
    const admin = { Authorization: "Bearer test-admin" };
    const history = await (await callWorker("/api/addresses/883309050/history", { headers: admin })).json() as { dossiers: { dossier_id: string }[]; events: { id: string }[] };
    expect(history.dossiers[0]?.dossier_id).toBe("d1");
    expect(history.events[0]?.id).toBe("event");
    expect(((await (await callWorker("/api/events?address=1234%20MARKET%20ST", { headers: admin })).json()) as { events: { id: string }[] }).events.map((e) => e.id)).toEqual(["event"]);
    await env.DB.prepare("UPDATE dossiers SET added_by = 'curated' WHERE id = 'd1'").run();
    const publicHistory = await (await callWorker("/api/addresses/883309050/history")).json() as { dossiers: { dossier_id: string }[] };
    expect(publicHistory.dossiers[0]?.dossier_id).toBe("d1");
  });

  it("refuses a public callback_url and does not copy a public dossier's callback onto a watch", async () => {
    await env.DB.prepare("UPDATE dossiers SET callback_url = 'https://evil.test/hook' WHERE id = 'd1'").run();
    const refused = await post("/api/dossiers/d1/watch", { callback_url: "https://evil.test/hook" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_input", detail: expect.stringMatching(/admin token/i) });
    fetchMock.intercept({ method: "POST", url: "https://agent.tinyfish.ai/v1/monitors", reply: { status: 201, json: { monitor: { id: "mon-1" }, run: { id: "baseline", results: [{ text: fx("li-1234-market.md") }], errors: [] } } } });
    expect((await post("/api/dossiers/d1/watch", {})).status).toBe(201);
    expect((await env.DB.prepare("SELECT callback_url FROM watches WHERE opa_account = '883309050'").first<{ callback_url: string | null }>())?.callback_url).toBeNull();
  });

  it("stores a callback_url from an admin and applies it to the watch", async () => {
    fetchMock.intercept({ method: "POST", url: "https://agent.tinyfish.ai/v1/monitors", times: 2, reply: { status: 201, json: { monitor: { id: "mon-1" }, run: { id: "baseline", results: [{ text: fx("li-1234-market.md") }], errors: [] } } } });
    const res = await callWorker("/api/dossiers/d1/watch", {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ callback_url: "https://callback.test/hook" }),
    });
    expect(res.status).toBe(201);
    expect((await env.DB.prepare("SELECT DISTINCT callback_url FROM watches WHERE opa_account = '883309050'").all<{ callback_url: string }>()).results)
      .toEqual([{ callback_url: "https://callback.test/hook" }]);
  });

  it("ignores an older Monitor run and updates only the newest resolved dossier after a change", async () => {
    const original = parseLi(fx("li-1234-market.md"))!;
    const changed = fx("li-1234-market-changed.md");
    await upsertParcelSection(env.DB, "883309050", "licenses_inspections", original, "1234 MARKET ST");
    await upsertSection(env.DB, "d1", "licenses_inspections", {
      status: "ok", method: "fetch", data: original, checked_at: "2026-10-01T00:00:00.000Z",
    });
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d-new','883309050','1234 MARKET ST','resolved','free','complete','public','2026-11-09T00:00:00.000Z',0)").run();
    await upsertSection(env.DB, "d-new", "licenses_inspections", {
      status: "ok", method: "fetch", data: original, checked_at: "2026-10-01T00:00:00.000Z",
    });
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status) VALUES ('w','883309050','li','mon-1','active')").run();
    const body = (id: string, text: string, finished_at: string) => ({ ...payload(text, id), finished_at });
    expect((await post("/hooks/monitor/test-secret", body("run-new", changed, "2026-11-09T12:00:00Z"))).status).toBe(200);
    const newest = (await getSections(env.DB, "d-new")).find((s) => s.section_id === "licenses_inspections");
    expect(newest?.data).toEqual(parseLi(changed));
    expect(newest?.checked_at).not.toBe("2026-10-01T00:00:00.000Z");
    expect(newest?.checked_at).toMatch(/Z$/);
    expect((await getSections(env.DB, "d1")).find((s) => s.section_id === "licenses_inspections")?.data).toEqual(original);
    const stale = await post("/hooks/monitor/test-secret", body("run-old", fx("li-1234-market.md"), "2026-11-08T12:00:00Z"));
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ ok: true, ignored: "stale" });
    expect(await getParcelSection(env.DB, "883309050", "licenses_inspections")).toEqual(parseLi(changed));
    expect((await getSections(env.DB, "d-new")).find((s) => s.section_id === "licenses_inspections")?.data).toEqual(parseLi(changed));
    expect((await env.DB.prepare("SELECT last_applied_at FROM watches WHERE id = 'w'").first<{ last_applied_at: string }>())?.last_applied_at)
      .toBe("2026-11-09T12:00:00.000Z");
  });

  it("asks concurrent deliveries for the same monitor to retry",async()=>{
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status) VALUES ('w','883309050','li','mon-1','active')").run();
    await env.DB.prepare("INSERT INTO monitor_processing (monitor_id,holder,started_at) VALUES ('mon-1','busy',?)").bind(new Date().toISOString()).run();
    expect((await post("/hooks/monitor/test-secret",payload(fx("li-1234-market.md")))).status).toBe(503);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM events").first<{n:number}>())?.n).toBe(0);
  });

  it("accepts the invented Monitor payload fixtures",async()=>{
    const original=reorderedFixture.results[0]!.text;
    await upsertParcelSection(env.DB,"883309050","licenses_inspections",parseLi(original)!);
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status) VALUES ('w','883309050','li','example-monitor','active')").run();
    expect((await post("/hooks/monitor/test-secret",loadingFixture)).status).toBe(200);
    expect((await post("/hooks/monitor/test-secret",reorderedFixture)).status).toBe(200);
    expect((await post("/hooks/monitor/test-secret",changedFixture)).status).toBe(200);
    const events=await env.DB.prepare("SELECT kind FROM events ORDER BY kind").all<{kind:string}>();
    expect(events.results.map(x=>x.kind)).toEqual(["new_permit","violation_closed"]);
    expect(parseProperty(saleFixture.results[0]!.text)?.sale_price_usd).toBe(200);
  });

  it("keeps a visitor's watched lookup out of the export, the history, the events and nearby", async () => {
    await upsertSection(env.DB, "d1", "property", {
      status: "ok", method: "fetch", checked_at: "2026-11-01T00:00:00.000Z",
      data: { opa_account: "883309050", owners: ["INVENTED OWNER ONE"] } as never,
    });
    await env.DB.prepare("UPDATE dossiers SET address_input = 'typed by a visitor' WHERE id = 'd1'").run();
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('near','9','1250 MARKET ST','resolved','free','complete','curated','2026-11-01T00:00:00.000Z',0)").run();
    monitorAnswers("mon-1");
    expect((await watchAs("d1", "192.0.2.9")).status).toBe(201);
    await env.DB.prepare("INSERT INTO events (id,opa_account,kind,at) VALUES ('event','883309050','new_permit','2026-11-02T00:00:00.000Z')").run();
    const exported = await (await callWorker("/api/export.json")).json() as { dossiers: { dossier_id: string }[] };
    expect(exported.dossiers.map((d) => d.dossier_id)).toEqual(["near"]);
    expect(await (await callWorker("/api/addresses/883309050/history")).json()).toEqual({ dossiers: [], events: [] });
    expect(await (await callWorker("/api/events")).json()).toEqual({ events: [] });
    expect(await (await callWorker("/api/dossiers/near/nearby")).json()).toEqual({ events: [] });
    const admin = { Authorization: "Bearer test-admin" };
    const history = await (await callWorker("/api/addresses/883309050/history", { headers: admin })).json() as { dossiers: { dossier_id: string }[]; events: { id: string }[] };
    expect(history.dossiers.map((d) => d.dossier_id)).toEqual(["d1"]);
    expect(history.events.map((e) => e.id)).toEqual(["event"]);
  });

  it("publishes a parcel we watch with the dossier we added, never a visitor's dossier of the same parcel", async () => {
    await env.DB.prepare("UPDATE dossiers SET address_input = 'typed by a visitor' WHERE id = 'd1'").run();
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_input, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d-admin','883309050','1234 Market St','1234 MARKET ST','resolved','free','complete','admin','2026-11-02T00:00:00.000Z',0)").run();
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by) VALUES ('w','883309050','li','mon-1','active','admin')").run();
    await env.DB.prepare("INSERT INTO events (id,opa_account,kind,at) VALUES ('event','883309050','sale','2026-11-01T00:00:00.000Z')").run();
    const exported = await (await callWorker("/api/export.json")).text();
    expect((JSON.parse(exported) as { dossiers: { dossier_id: string }[] }).dossiers.map((d) => d.dossier_id)).toEqual(["d-admin"]);
    expect(exported).not.toContain("typed by a visitor");
    const historyText = await (await callWorker("/api/addresses/883309050/history")).text();
    const history = JSON.parse(historyText) as { dossiers: { dossier_id: string }[]; events: { id: string }[] };
    expect(history.dossiers.map((d) => d.dossier_id)).toEqual(["d-admin"]);
    expect(history.events.map((e) => e.id)).toEqual(["event"]);
    expect(historyText).not.toContain("typed by a visitor");
  });

  it("lets a visitor start one watch a day", async () => {
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d2','2','1250 MARKET ST','resolved','free','complete','public','2026-11-01T00:00:00.000Z',0)").run();
    monitorAnswers("m1");
    expect((await watchAs("d1", "192.0.2.1")).status).toBe(201);
    const second = await watchAs("d2", "192.0.2.1");
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: "rate_limited", limit: PUBLIC_WATCHES_PER_IP_PER_DAY });
    expect(fetchMock.calls).toHaveLength(1);
    monitorAnswers("m2");
    expect((await watchAs("d2", "192.0.2.2")).status).toBe(201);
  });

  it("gives the day's watch back when the watch is refused", async () => {
    for (let i = 0; i < 4; i++) await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by) VALUES (?,?, 'li',?,'active','public')").bind(`w${i}`, `opa${i}`, `m${i}`).run();
    expect((await watchAs("d1", "192.0.2.3")).status).toBe(409);
    await env.DB.prepare("DELETE FROM watches").run();
    fetchMock.intercept({ method: "POST", url: MONITORS, reply: { status: 400, json: { error: { code: "invalid_input", message: "no" } } } });
    expect((await watchAs("d1", "192.0.2.3")).status).toBe(502);
    monitorAnswers("m1");
    expect((await watchAs("d1", "192.0.2.3")).status).toBe(201);
  });

  it("does not count the admin's watches against a day", async () => {
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d2','2','1250 MARKET ST','resolved','free','complete','admin','2026-11-01T00:00:00.000Z',0)").run();
    const asAdmin = (id: string) => callWorker(`/api/dossiers/${id}/watch`, { method: "POST", headers: { authorization: "Bearer test-admin" } });
    monitorAnswers("a1");
    fetchMock.intercept({ method: "POST", url: MONITORS, reply: { status: 201, json: { monitor: { id: "a2" }, run: { id: "baseline", results: [{ text: fx("property-1234-market.md") }], errors: [] } } } });
    monitorAnswers("a3");
    fetchMock.intercept({ method: "POST", url: MONITORS, reply: { status: 201, json: { monitor: { id: "a4" }, run: { id: "baseline", results: [{ text: fx("property-1234-market.md") }], errors: [] } } } });
    expect((await asAdmin("d1")).status).toBe(201);
    expect((await asAdmin("d2")).status).toBe(201);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_use").first<{ n: number }>())?.n).toBe(0);
  });

  it("drops the old screenshot from a sheet the Monitor has read again, and writes the change into our own dossier of the address", async () => {
    const original = parseLi(fx("li-1234-market.md"))!;
    const changed = fx("li-1234-market-changed.md");
    await upsertParcelSection(env.DB, "883309050", "licenses_inspections", original, "1234 MARKET ST");
    // Ours is the older one; d1 is a visitor's newer dossier of the same address.
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd) VALUES ('d-ours','883309050','1234 MARKET ST','resolved','free','complete','curated','2026-10-01T00:00:00.000Z',0)").run();
    for (const id of ["d-ours", "d1"]) {
      await upsertSection(env.DB, id, "licenses_inspections", {
        status: "error", error: "incomplete_after_retries", method: "fetch", data: original, checked_at: "2026-10-01T00:00:00.000Z", evidence_key: `evidence/${id}/li.jpg`,
      });
    }
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by) VALUES ('w','883309050','li','mon-1','active','curated')").run();
    expect((await post("/hooks/monitor/test-secret", payload(changed))).status).toBe(200);
    const sheet = async (id: string) => (await getSections(env.DB, id)).find((x) => x.section_id === "licenses_inspections");
    const ours = await sheet("d-ours");
    expect(ours?.data).toEqual(parseLi(changed));
    expect(ours?.status).toBe("ok");
    expect(ours?.error).toBeNull();
    // The stored screenshot is of the earlier read, so it no longer stands beside the new data.
    expect(ours?.evidence_key).toBeNull();
    const visitors = await sheet("d1");
    expect(visitors?.data).toEqual(original);
    expect(visitors?.evidence_key).toBe("evidence/d1/li.jpg");
  });

  it("writes a change a visitor's watch reports into that visitor's own dossier, not a later visitor's", async () => {
    const original = parseLi(fx("li-1234-market.md"))!;
    const changed = fx("li-1234-market-changed.md");
    const owner = await visitorHash(env, "192.0.2.1"), later = await visitorHash(env, "192.0.2.2");
    await upsertParcelSection(env.DB, "883309050", "licenses_inspections", original, "1234 MARKET ST");
    await env.DB.prepare("UPDATE dossiers SET ip_hash = ? WHERE id = 'd1'").bind(owner).run();
    await env.DB.prepare("INSERT INTO dossiers (id, opa_account, address_resolved, outcome, tier, status, added_by, created_at, spend_usd, ip_hash) VALUES ('d-later','883309050','1234 MARKET ST','resolved','free','complete','public','2026-11-09T00:00:00.000Z',0,?)").bind(later).run();
    for (const id of ["d1", "d-later"]) await upsertSection(env.DB, id, "licenses_inspections", { status: "ok", method: "fetch", data: original, checked_at: "2026-10-01T00:00:00.000Z" });
    await env.DB.prepare("INSERT INTO watches (id, opa_account, kind, monitor_id, status, added_by, owner_hash) VALUES ('w','883309050','li','mon-1','active','public',?)").bind(owner).run();
    expect((await post("/hooks/monitor/test-secret", payload(changed))).status).toBe(200);
    const data = async (id: string) => (await getSections(env.DB, id)).find((x) => x.section_id === "licenses_inspections")?.data;
    expect(await data("d1")).toEqual(parseLi(changed));
    expect(await data("d-later")).toEqual(original);
  });

});
