import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDeps, runAgentSection, finishAgentSections } from "../src/dossier/agentSteps";
import { runCron } from "../src/cron";
import { fetchMock } from "./helpers/fetch-mock";

beforeEach(async () => {
  fetchMock.activate();
  await env.DB.batch(["events","watches","parcels","sections","dossiers","spend","agent_inflight"].map(t=>env.DB.prepare(`DELETE FROM ${t}`)));
});
afterEach(()=>{ fetchMock.reset(); vi.restoreAllMocks(); });
const monitorList = () => fetchMock.intercept({method:"GET",url:"https://agent.tinyfish.ai/v1/monitors",reply:{json:{monitors:[]}}});
describe("hourly cron",()=>{
  it("deletes due owned monitors before expiring watches, retains events and retries failures",async()=>{
    await env.DB.prepare("INSERT INTO watches (id,opa_account,kind,monitor_id,status,added_by,expires_at) VALUES ('ok','1','li','m1','active','public','2020-01-01T00:00:00.000Z'),('bad','2','li','m2','active','public','2020-01-01T00:00:00.000Z')").run();
    await env.DB.prepare("INSERT INTO events (id,opa_account,kind) VALUES ('e','1','sale')").run();
    fetchMock.intercept({method:"DELETE",url:"https://agent.tinyfish.ai/v1/monitors/m1",reply:{status:204}});
    fetchMock.intercept({method:"DELETE",url:"https://agent.tinyfish.ai/v1/monitors/m2",reply:{status:500}}); monitorList();
    await runCron(env);
    expect((await env.DB.prepare("SELECT id,status FROM watches ORDER BY id").all()).results).toEqual([{id:"bad",status:"active"},{id:"ok",status:"expired"}]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM events").first<{n:number}>())?.n).toBe(1);
  });
  it("expires unwatched public dossiers and deletes only unshared evidence",async()=>{
    await env.STORE.put("evidence/old.jpg","old"); await env.STORE.put("evidence/shared.jpg","shared");
    await env.DB.prepare("INSERT INTO dossiers (id,opa_account,added_by,expires_at) VALUES ('old','1','public','2020-01-01T00:00:00.000Z'),('kept','2','admin',NULL)").run();
    await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,evidence_key) VALUES ('old','property','ok','evidence/old.jpg'),('old','zoning','ok','evidence/shared.jpg'),('kept','property','ok','evidence/shared.jpg')").run(); monitorList();
    await runCron(env);
    expect(await env.DB.prepare("SELECT id FROM dossiers WHERE id='old'").first()).toBeNull();
    expect(await env.STORE.get("evidence/old.jpg")).toBeNull(); expect(await env.STORE.get("evidence/shared.jpg")).not.toBeNull();
  });
  it("releases only a stale Agent slot",async()=>{
    await env.DB.prepare("INSERT INTO agent_inflight VALUES (1,'holder','2020-01-01T00:00:00.000Z')").run(); monitorList(); await runCron(env);
    expect(await env.DB.prepare("SELECT * FROM agent_inflight").first()).toBeNull();
  });
  it("times out the sheets of a stalled workflow, keeps what was read, and checks health without touching unrelated monitors", async () => {
    const free = ["property", "zoning", "licenses_inspections", "deeds"];
    const agent = ["assessment_history", "tax", "schools", "flood"];
    await env.DB.prepare(
      `INSERT INTO dossiers (id,status,tier,added_by,outcome,workflow_id,workflow_started_at) VALUES
        ('read','partial','standard','admin','resolved','wf','2020-01-01T00:00:00.000Z'),
        ('nothing','partial','standard','admin','resolved','wf3','2020-01-01T00:00:00.000Z'),
        ('new','partial','standard','admin','resolved','wf2','2999-01-01T00:00:00.000Z')`,
    ).run();
    for (const sid of free) {
      await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,method,checked_at) VALUES ('read',?, 'ok','fetch','2020-01-01T00:00:10.000Z')").bind(sid).run();
      await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,method) VALUES ('nothing',?, 'pending','fetch')").bind(sid).run();
    }
    for (const sid of agent) {
      for (const id of ["read", "nothing", "new"]) {
        await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,method) VALUES (?,?, 'pending','agent')").bind(id, sid).run();
      }
    }
    fetchMock.intercept({method:"GET",url:"https://agent.tinyfish.ai/v1/monitors",reply:{json:{monitors:[{id:"other",status:"active"}]}}});
    await runCron(env);
    const dossier = (id: string) => env.DB.prepare("SELECT status,completed_at FROM dossiers WHERE id=?").bind(id).first<{ status: string; completed_at: string | null }>();
    const sheets = async (id: string) => (await env.DB.prepare("SELECT section_id,status,error FROM sections WHERE dossier_id=? ORDER BY section_id").bind(id).all<{ section_id: string; status: string; error: string | null }>()).results;
    // Four sheets were read: the dossier is complete with gaps, never failed, so it can still be opened and upgraded.
    expect(await dossier("read")).toMatchObject({ status: "complete", completed_at: expect.any(String) });
    expect((await sheets("read")).filter((r) => r.status === "ok").map((r) => r.section_id)).toEqual([...free].sort());
    expect((await sheets("read")).filter((r) => r.status === "error").map((r) => r.error)).toEqual(Array(4).fill("workflow_timeout"));
    // Nothing was read at all: every requested sheet is an error, and that is the one case that fails.
    expect((await dossier("nothing"))?.status).toBe("failed");
    expect((await sheets("nothing")).every((r) => r.status === "error" && r.error === "workflow_timeout")).toBe(true);
    // A workflow still inside its time is left alone.
    expect((await dossier("new"))?.status).toBe("partial");
    expect((await sheets("new")).every((r) => r.status === "pending")).toBe(true);
    await finishAgentSections(env, "read");
    expect((await dossier("read"))?.status).toBe("complete");
    expect(fetchMock.calls).toHaveLength(1);
  });
  it("preserves a timeout when an in-flight Agent result arrives later",async()=>{
    await env.DB.prepare("INSERT INTO dossiers (id,status,workflow_id,workflow_started_at,added_by,tier,spend_usd) VALUES ('d','partial','wf','2020-01-01T00:00:00.000Z','admin','standard',0)").run();
    await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,method) VALUES ('d','tax','pending','agent')").run();
    vi.spyOn(agentDeps,"run").mockImplementation(async()=>{
      monitorList(); await runCron(env);
      return {runId:"late",status:"COMPLETED",result:{balance_usd:"$10",delinquent:null,as_of:"01/02/2025"},numOfSteps:1,error:null,steps:[],finishedAt:null};
    });
    await runAgentSection(env,"d","tax");
    expect(await env.DB.prepare("SELECT status,error FROM sections WHERE dossier_id='d'").first()).toEqual({status:"error",error:"workflow_timeout"});
  });

  it("retries evidence deletion after a temporary R2 failure",async()=>{
    await env.STORE.put("evidence/retry.jpg","data");
    await env.DB.prepare("INSERT INTO dossiers (id,opa_account,added_by,expires_at) VALUES ('old','1','public','2020-01-01T00:00:00.000Z')").run();
    await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,evidence_key) VALUES ('old','property','ok','evidence/retry.jpg')").run();
    const realDelete = env.STORE.delete.bind(env.STORE);
    const spy=vi.spyOn(env.STORE,"delete").mockRejectedValueOnce(new Error("temporary"));
    monitorList(); await runCron(env);
    expect(await env.STORE.get("evidence/retry.jpg")).not.toBeNull();
    spy.mockImplementation(realDelete); monitorList(); await runCron(env);
    expect(await env.STORE.get("evidence/retry.jpg")).toBeNull();
  });

  it("settles a partial dossier with no pending section and does not touch a failed one", async () => {
    await env.DB.prepare("INSERT INTO dossiers (id,status,tier,added_by,outcome,workflow_id,workflow_started_at) VALUES ('stuck','partial','standard','admin','resolved','wf','2020-01-01T00:00:00.000Z'),('dead','failed','standard','admin','resolved','wf2','2020-01-01T00:00:00.000Z')").run();
    const free = ["property", "zoning", "licenses_inspections", "deeds"];
    const agent = ["assessment_history", "tax", "schools", "flood"];
    for (const id of ["stuck", "dead"]) {
      for (const sid of free) {
        await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,method) VALUES (?,?, 'ok','fetch')").bind(id, sid).run();
      }
      for (const sid of agent) {
        await env.DB.prepare("INSERT INTO sections (dossier_id,section_id,status,method) VALUES (?,?, 'error','agent')").bind(id, sid).run();
      }
    }
    monitorList();
    await runCron(env);
    expect((await env.DB.prepare("SELECT status,completed_at FROM dossiers WHERE id='stuck'").first<{ status: string; completed_at: string | null }>()))
      .toMatchObject({ status: "complete", completed_at: expect.any(String) });
    expect((await env.DB.prepare("SELECT status FROM dossiers WHERE id='dead'").first<{ status: string }>())?.status).toBe("failed");
  });

});
