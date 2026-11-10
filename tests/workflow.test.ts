// Exercises serial Agent steps, pauses, reuse, the deep route, and completion.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SECTION_MAX_USD, SPEND_PAUSE_USD } from "../src/core/limits";
import { PRICES, recordSpend } from "../src/core/spend";
import { insertDossier, getDossier } from "../src/db/dossiers";
import { acquireAgentSlot, releaseAgentSlot, slotHolder } from "../src/db/inflight";
import { getSections, upsertSection } from "../src/db/sections";
import { agentDeps, finishAgentSections, giveUpAgentSection, runAgentSection, runDossierSections,
  SLOT_WAIT_TURNS } from "../src/dossier/agentSteps";
import { startAgentSections } from "../src/dossier/build";
import { buildDeps } from "../src/dossier/deps";
import { FREE_SECTION_IDS } from "../src/sections/index";
import { AgentRunError } from "../src/tinyfish/agent";
import { callWorker } from "./helpers/app";
import { fetchMock } from "./helpers/fetch-mock";
import deep from "./fixtures/agent/li-deep.json";

const run = { runId: "run-1", status: "COMPLETED", result: { balance_usd: "$10", delinquent: null,
  as_of: "01/02/2025" }, numOfSteps: 2, error: null,
  steps: [{ id: "step", action: "Read balance", screenshot: "https://example.test/a" }], finishedAt: null };
async function seed(added_by: "public" | "admin" = "admin", section: "tax" | "li_deep" = "tax") {
  const id = await insertDossier(env.DB, { tier: "standard", status: "partial", added_by, outcome: "resolved",
    opa_account: "111111111", address_resolved: "1 EXAMPLE ST" });
  await upsertSection(env.DB, id, section, { status: "pending", method: "agent" });
  return id;
}
const section = async (id: string, name = "tax") => (await getSections(env.DB, id)).find((s) => s.section_id === name)!;
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM sections"), env.DB.prepare("DELETE FROM dossiers"),
    env.DB.prepare("DELETE FROM spend"), env.DB.prepare("DELETE FROM agent_inflight")]);
  vi.spyOn(agentDeps, "get").mockRejectedValue(new Error("unread"));
  vi.spyOn(agentDeps, "poll").mockRejectedValue(new Error("unpolled"));
});
afterEach(() => { vi.restoreAllMocks(); fetchMock.reset(); });

describe("Agent workflow steps", () => {
  it.each([null, "existing-run"])("finishes after a section exhausts retries with run id %s", async (runId) => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { run_id: runId });
    await upsertSection(env.DB, id, "schools", { status: "pending", method: "agent" });
    const calls: string[] = [];
    const configs: Record<string, object> = {};
    const step = {
      async do(name: string, config: object, callback: () => Promise<void>): Promise<void> {
        calls.push(name);
        configs[name] = config;
        if (name === "tax") throw new Error("retries exhausted");
        if (name === "schools") {
          await upsertSection(env.DB, id, "schools", { status: "ok" });
          return;
        }
        await callback();
      },
      async sleep(): Promise<void> {},
    };
    await runDossierSections(env, { dossierId: id, sections: ["tax", "schools"] }, step);
    expect(await section(id)).toMatchObject({
      status: "error",
      error: runId ? "agent_poll_failed" : "agent_not_started",
    });
    expect(calls).toEqual(["tax", "tax:give-up", "schools", "finish"]);
    expect(configs.finish).toMatchObject({ retries: { limit: 2, delay: "30 seconds", backoff: "constant" } });
  });

  it("leaves a terminal section unchanged when giving up", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "ok", error: null });
    const before = await section(id);
    await giveUpAgentSection(env, id, "tax");
    expect(await section(id)).toEqual(before);
  });

  it("stores a cancelled run and its spend", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockResolvedValue({ ...run, status: "CANCELLED", error: null, steps: [] });
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "error", error: "agent_cancelled", spend_usd: 0.032 });
  });

  it("reuses a recent successful flood result", async () => {
    const old = await seed();
    await upsertSection(env.DB, old, "flood", {
      status: "ok", method: "agent", checked_at: new Date().toISOString(), data: { flood_zone: "X" },
    });
    const id = await seed();
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create");
    expect(await startAgentSections(env, id, ["flood"])).toBe(0);
    expect(await section(id, "flood")).toMatchObject({ status: "ok", data: { flood_zone: "X" }, spend_usd: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("stores completed data, evidence, spend and releases the slot", async () => {
    const id = await seed();
    fetchMock.activate();
    const api = "https://agent.tinyfish.ai/v1";
    fetchMock.intercept({ url: `${api}/automation/run-async`, method: "POST", reply: { json: { run_id: run.runId } } });
    const response = { status: run.status, result: run.result, num_of_steps: 2, steps: run.steps };
    fetchMock.intercept({ url: `${api}/runs/run-1?screenshots=none&html=none`, reply: { json: response } });
    fetchMock.intercept({ url: `${api}/runs/run-1?screenshots=url&html=none`, reply: { json: response } });
    fetchMock.intercept({ url: `${api}/runs/run-1/steps/step/screenshot`,
      reply: { body: "image", headers: { "content-type": "image/jpeg" } } });
    await runAgentSection(env, id, "tax", { sleep: async () => {} });
    expect(await section(id)).toMatchObject({ status: "ok", run_id: "run-1", spend_usd: 0.032,
      evidence_key: `evidence/${id}/tax.jpg`, data: { balance_usd: 10 } });
    expect(await env.STORE.get(`evidence/${id}/tax.jpg`)).not.toBeNull();
    expect((await getDossier(env.DB, id))!.spend_usd).toBe(0.032);
    const ledger = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend").all();
    expect(ledger.results).toEqual([{ kind: "agent_step", amount_usd: 0.032, ref: "run-1" }]);
    expect(await slotHolder(env.DB)).toBeNull();
  });
  it("answers busy at once while another section holds the slot, and starts when it is free", async () => {
    const id = await seed();
    await acquireAgentSlot(env.DB, "other");
    const start = vi.spyOn(agentDeps, "run").mockResolvedValue(run);
    vi.spyOn(agentDeps, "download").mockResolvedValue(new ArrayBuffer(1));
    const sleep = vi.fn(async () => {});
    expect(await runAgentSection(env, id, "tax", { sleep })).toBe("busy");
    expect(start).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({ status: "pending", run_id: null });
    expect((await slotHolder(env.DB))?.holder).toBe("other");
    await releaseAgentSlot(env.DB, "other");
    expect(await runAgentSection(env, id, "tax", { sleep })).toBe("done");
    expect(start).toHaveBeenCalledOnce();
    expect(await section(id)).toMatchObject({ status: "ok" });
  });

  it("sleeps in the Workflow, not in a step, while the slot is held, then starts the section", async () => {
    const id = await seed();
    await acquireAgentSlot(env.DB, "other");
    const start = vi.spyOn(agentDeps, "run").mockResolvedValue(run);
    vi.spyOn(agentDeps, "download").mockResolvedValue(new ArrayBuffer(1));
    const names: string[] = [];
    const step = {
      async do<T>(name: string, _config: object, callback: () => Promise<T>): Promise<T> {
        names.push(name);
        return callback();
      },
      async sleep(name: string, ms: number): Promise<void> {
        names.push(`${name} ${ms}`);
        if (name === "tax:wait:1") await releaseAgentSlot(env.DB, "other");
      },
    };
    await runDossierSections(env, { dossierId: id, sections: ["tax"] }, step);
    expect(names).toEqual(["tax", "tax:wait:0 20000", "tax:1", "tax:wait:1 20000", "tax:2", "finish"]);
    expect(start).toHaveBeenCalledOnce();
    expect(await section(id)).toMatchObject({ status: "ok" });
  });

  it("gives a section up, without starting a run, when the slot never comes free", async () => {
    const id = await seed();
    await acquireAgentSlot(env.DB, "other");
    const start = vi.spyOn(agentDeps, "run");
    let sleeps = 0;
    const names: string[] = [];
    const step = {
      async do<T>(name: string, _config: object, callback: () => Promise<T>): Promise<T> {
        names.push(name);
        return callback();
      },
      async sleep(): Promise<void> { sleeps += 1; },
    };
    await runDossierSections(env, { dossierId: id, sections: ["tax"] }, step);
    expect(sleeps).toBe(SLOT_WAIT_TURNS);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(-2)).toEqual(["tax:give-up", "finish"]);
    expect(start).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({ status: "error", error: "agent_not_started" });
    expect((await slotHolder(env.DB))?.holder).toBe("other");
  });
  it("does not restart terminal sections or a pending section with a recorded run", async () => {
    const id = await seed();
    const start = vi.spyOn(agentDeps, "run");
    await upsertSection(env.DB, id, "tax", { status: "ok" });
    await runAgentSection(env, id, "tax");
    await upsertSection(env.DB, id, "tax", { status: "pending", run_id: "existing" });
    await runAgentSection(env, id, "tax");
    expect(start).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({ status: "error", error: "agent_poll_failed", run_id: "existing" });
  });

  it("stores a recorded run that is already terminal instead of starting another", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "pending", run_id: "already-started" });
    vi.mocked(agentDeps.get).mockResolvedValue({
      status: "COMPLETED", result: run.result, num_of_steps: 2, finished_at: null, error: null, steps: [],
    });
    vi.spyOn(agentDeps, "finalize").mockResolvedValue({ ...run, runId: "already-started" });
    vi.spyOn(agentDeps, "download").mockResolvedValue(new ArrayBuffer(1));
    const start = vi.spyOn(agentDeps, "run");
    await runAgentSection(env, id, "tax");
    expect(start).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({ status: "ok", run_id: "already-started", spend_usd: 0.032 });
    expect(await slotHolder(env.DB)).toBeNull();
  });

  it("polls a recorded run that is still going, and never starts a second run", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "pending", run_id: "live-run" });
    vi.mocked(agentDeps.get).mockResolvedValue({
      status: "RUNNING", result: null, num_of_steps: null, finished_at: null, error: null, steps: [],
    });
    vi.mocked(agentDeps.poll).mockResolvedValue({ ...run, runId: "live-run" });
    vi.spyOn(agentDeps, "download").mockResolvedValue(new ArrayBuffer(1));
    const start = vi.spyOn(agentDeps, "run");
    await runAgentSection(env, id, "tax", { sleep: async () => {} });
    expect(start).not.toHaveBeenCalled();
    expect(agentDeps.poll).toHaveBeenCalledOnce();
    expect(await section(id)).toMatchObject({ status: "ok", run_id: "live-run" });
  });

  it("marks a section unavailable when spend crosses the pause while waiting for the slot", async () => {
    const id = await seed("public");
    await recordSpend(env.DB, "agent_step", 5.9, "seed");
    await acquireAgentSlot(env.DB, "other");
    const start = vi.spyOn(agentDeps, "run").mockResolvedValue(run);
    expect(await runAgentSection(env, id, "tax")).toBe("busy");
    await recordSpend(env.DB, "agent_step", 0.2, "during-wait");
    await releaseAgentSlot(env.DB, "other");
    expect(await runAgentSection(env, id, "tax")).toBe("done");
    expect(start).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({
      status: "unavailable",
      error: "budget paused for public requests; the free core is complete",
    });
    expect(await slotHolder(env.DB)).toBeNull();
  });

  it("books the section ceiling when a timeout cannot recover the run", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockRejectedValue(new AgentRunError(504, "agent_timeout", "x", "billed-run", "timeout"));
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "error", error: "agent_timeout" });
    expect(await env.DB.prepare("SELECT amount_usd, ref FROM spend WHERE ref = 'billed-run'").first()).toEqual({
      amount_usd: AGENT_SECTION_MAX_USD, ref: "billed-run",
    });
    expect(await slotHolder(env.DB)).not.toBeNull();
  });

  it("stores a timed-out run that is already terminal and replaces the ceiling with the true spend", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockRejectedValue(new AgentRunError(504, "agent_timeout", "x", "late-run", "timeout"));
    vi.mocked(agentDeps.get).mockResolvedValue({
      status: "COMPLETED", result: run.result, num_of_steps: 2, finished_at: null, error: null, steps: [],
    });
    vi.spyOn(agentDeps, "finalize").mockImplementation(async (e, runId, polled) => {
      await recordSpend(e.DB, "agent_step", 0.032, runId);
      return { runId, status: polled.status, result: polled.result, numOfSteps: polled.num_of_steps,
        error: polled.error, steps: polled.steps, finishedAt: polled.finished_at };
    });
    vi.spyOn(agentDeps, "download").mockResolvedValue(new ArrayBuffer(1));
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "ok", run_id: "late-run", spend_usd: 0.032 });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM spend WHERE ref = 'late-run'").first<{ n: number }>())?.n).toBe(1);
    expect(await slotHolder(env.DB)).toBeNull();
  });
  it("answers busy for a recorded run that is still going while another section holds the slot", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "pending", run_id: "live-run" });
    await acquireAgentSlot(env.DB, "other");
    vi.mocked(agentDeps.get).mockResolvedValue({
      status: "RUNNING", result: null, num_of_steps: null, finished_at: null, error: null, steps: [],
    });
    expect(await runAgentSection(env, id, "tax")).toBe("busy");
    expect(agentDeps.poll).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({ status: "pending", run_id: "live-run" });
  });

  it("starts one Workflow for each section, so no instance makes more than one section's requests", async () => {
    const id = await seed();
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    expect(await startAgentSections(env, id, ["assessment_history", "tax", "schools"])).toBe(3);
    const made = create.mock.calls.map(([arg]) => arg as { id: string; params: { dossierId: string; sections: string[] } });
    expect(made.map((m) => m.params)).toEqual([
      { dossierId: id, sections: ["assessment_history"] },
      { dossierId: id, sections: ["tax"] },
      { dossierId: id, sections: ["schools"] },
    ]);
    expect(made[1]!.id).toMatch(new RegExp(`^${id}-tax-[0-9a-f]{8}$`));
    for (const m of made) expect(m.id.length).toBeLessThanOrEqual(100);
    expect(await getDossier(env.DB, id)).toMatchObject({ status: "partial", workflow_id: made[0]!.id });
  });

  it("reads again a run that was paid for and never read, instead of buying a second one", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "error", error: "agent_poll_failed", run_id: "paid-run" });
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    expect(await startAgentSections(env, id, ["tax"])).toBe(1);
    expect(create).toHaveBeenCalledOnce();
    expect(await section(id)).toMatchObject({ status: "pending", error: null, run_id: "paid-run" });

    vi.mocked(agentDeps.get).mockResolvedValue({
      status: "COMPLETED", result: run.result, num_of_steps: 2, finished_at: null, error: null, steps: [],
    });
    vi.spyOn(agentDeps, "finalize").mockResolvedValue({ ...run, runId: "paid-run" });
    vi.spyOn(agentDeps, "download").mockResolvedValue(new ArrayBuffer(1));
    const start = vi.spyOn(agentDeps, "run");
    expect(await runAgentSection(env, id, "tax")).toBe("done");
    expect(start).not.toHaveBeenCalled();
    expect(await section(id)).toMatchObject({ status: "ok", run_id: "paid-run", data: { balance_usd: 10 } });
  });

  it("starts a failed section afresh when its run was read and had failed", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "error", error: "agent_failed: site down", run_id: "dead-run" });
    vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    expect(await startAgentSections(env, id, ["tax"])).toBe(1);
    expect(await section(id)).toMatchObject({ status: "pending", error: null, run_id: null });
  });

  it("posts the callback once when two instances finish a dossier that is complete", async () => {
    const id = await seed();
    await env.DB.prepare("UPDATE dossiers SET callback_url = ? WHERE id = ?").bind("https://example.test/cb", id).run();
    for (const name of ["property", "zoning", "licenses_inspections", "deeds", "assessment_history", "schools", "flood", "tax"] as const)
      await upsertSection(env.DB, id, name, { status: "ok" });
    fetchMock.activate();
    fetchMock.intercept({ url: "https://example.test/cb", method: "POST", reply: { status: 204 } });
    await finishAgentSections(env, id);
    await finishAgentSections(env, id);
    expect(fetchMock.calls).toHaveLength(1);
    expect(await getDossier(env.DB, id)).toMatchObject({ status: "complete" });
  });

  it("retries the failed sections of a dossier for an admin, and only those", async () => {
    const id = await seed();
    const post = (target: string, admin = false) => callWorker(`/api/dossiers/${target}/retry`, {
      method: "POST", headers: admin ? { Authorization: `Bearer ${env.ADMIN_TOKEN}` } : {},
    });
    expect((await post(id)).status).toBe(403);
    expect((await post("unknown", true)).status).toBe(404);
    await upsertSection(env.DB, id, "tax", { status: "ok", method: "agent", run_id: "kept" });
    await upsertSection(env.DB, id, "property", { status: "error", method: "fetch", error: "unrecognized_page" });
    expect((await post(id, true)).status).toBe(409);
    expect(await (await post(id, true)).json()).toEqual({ error: "nothing_to_retry" });

    await upsertSection(env.DB, id, "schools", { status: "error", method: "agent", error: "agent_poll_failed", run_id: "paid" });
    await upsertSection(env.DB, id, "flood", { status: "error", method: "agent", error: "agent_start_uncertain" });
    await env.DB.prepare("UPDATE dossiers SET status = 'complete' WHERE id = ?").bind(id).run();
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    const response = await post(id, true);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ dossier_id: id, status: "partial", sections: ["schools", "flood"] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(await section(id, "schools")).toMatchObject({ status: "pending", run_id: "paid" });
    expect(await section(id, "flood")).toMatchObject({ status: "pending", run_id: null });
    expect(await section(id, "tax")).toMatchObject({ status: "ok", run_id: "kept" });
    expect(await section(id, "property")).toMatchObject({ status: "error" });
    expect(await getDossier(env.DB, id)).toMatchObject({ status: "partial" });
  });

  it("retries only the sections named in the request, when it names any", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "ok", method: "agent" });
    await upsertSection(env.DB, id, "schools", { status: "error", method: "agent", error: "agent_poll_failed", run_id: "paid" });
    await upsertSection(env.DB, id, "flood", { status: "error", method: "agent", error: "agent_start_uncertain" });
    const post = (body: unknown) => callWorker(`/api/dossiers/${id}/retry`, {
      method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    expect((await post({ sections: "schools" })).status).toBe(400);
    expect((await post({ sections: ["tax"] })).status).toBe(409);
    expect(create).not.toHaveBeenCalled();
    const response = await post({ sections: ["schools"] });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ sections: ["schools"] });
    expect(create).toHaveBeenCalledOnce();
    expect(await section(id, "schools")).toMatchObject({ status: "pending", run_id: "paid" });
    expect(await section(id, "flood")).toMatchObject({ status: "error", error: "agent_start_uncertain" });
  });
  it("gives the FEMA search a short step limit, because it is known to find nothing in an automated browser", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "flood", { status: "pending", method: "agent" });
    const start = vi.spyOn(agentDeps, "run").mockResolvedValue({ ...run, result: { no_results: true }, steps: [] });
    await runAgentSection(env, id, "flood");
    expect(start.mock.calls[0]![1]).toMatchObject({ maxSteps: 6 });
    await runAgentSection(env, id, "tax");
    expect(start.mock.calls[1]![1]).not.toHaveProperty("maxSteps");
  });
  it("marks deep results extended when counts exceed returned rows", async () => {
    const id = await seed("admin", "li_deep");
    await upsertSection(env.DB, id, "licenses_inspections", { status: "ok", method: "fetch" });
    vi.spyOn(agentDeps, "run").mockResolvedValue({ ...run, result: deep.result, steps: [] });
    await runAgentSection(env, id, "li_deep");
    expect(await section(id, "licenses_inspections")).toMatchObject({ depth: "extended", rows_returned: 8 });
  });
  it.each([[8, "admin", "budget_paused"], [6, "public", "budget paused for public requests; the free core is complete"]] as const)
  ("pauses at $%s", async (amount, who, reason) => {
    const id = await seed(who);
    await recordSpend(env.DB, "agent_step", amount, "seed");
    const start = vi.spyOn(agentDeps, "run");
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "unavailable", error: reason });
    expect(start).not.toHaveBeenCalled();
    expect(await slotHolder(env.DB)).toBeNull();
  });
  it.each([
    [new AgentRunError(400, "bad_input", "x", null, "start"), false, "bad_input"],
    [new AgentRunError(503, "http_503", "x", null, "start"), true, "agent_start_uncertain"],
    [new AgentRunError(0, "network_error", "x", null, "start"), true, "agent_start_uncertain"],
    // The platform refused to send the request at all: no run exists, so the slot is freed and the reason says why.
    [new AgentRunError(0, "subrequest_limit", "x", null, "start"), false, "subrequest_limit"],
    [new AgentRunError(0, "network_error", "x", "r", "poll"), true, "agent_poll_failed"],
    [new AgentRunError(504, "agent_timeout", "x", "r", "timeout"), true, "agent_timeout"],
  ])("preserves the slot according to failure phase", async (error, held, reason) => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockRejectedValue(error);
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "error", error: reason });
    expect((await slotHolder(env.DB)) !== null).toBe(held);
  });
  it("retries a definite busy start after releasing the slot", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockRejectedValue(new AgentRunError(429, "busy", "x", null, "start"));
    await expect(runAgentSection(env, id, "tax")).rejects.toThrow();
    expect(await slotHolder(env.DB)).toBeNull();
  });
  it("records a failed run and its spend", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockResolvedValue({ ...run, status: "FAILED", error: "failed", steps: [] });
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "error", error: "agent_failed: failed", spend_usd: 0.032 });
    expect(await slotHolder(env.DB)).toBeNull();
  });
  it("records unreadable output without changing the evidence or spend rule", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockResolvedValue({ ...run, result: "junk", steps: [] });
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "error", error: "unreadable_result", spend_usd: 0.032 });
    expect(await slotHolder(env.DB)).toBeNull();
  });
  it("does not discard a successful result when evidence fails", async () => {
    const id = await seed();
    vi.spyOn(agentDeps, "run").mockResolvedValue(run);
    vi.spyOn(agentDeps, "download").mockRejectedValue(new Error("failure"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runAgentSection(env, id, "tax");
    expect(await section(id)).toMatchObject({ status: "ok", evidence_key: null });
  });
  it("reuses a recent flood result without starting a workflow", async () => {
    const old = await seed();
    await upsertSection(env.DB, old, "flood", { status: "unavailable", method: "agent", error: "no result",
      checked_at: new Date().toISOString(), data: { no_results: true }, evidence_key: "evidence/old/flood.jpg" });
    const id = await seed();
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create");
    expect(await startAgentSections(env, id, ["flood"])).toBe(0);
    expect(await section(id, "flood")).toMatchObject({ status: "unavailable", error: "no result", spend_usd: 0 });
    expect(create).not.toHaveBeenCalled();
  });
  it("starts a flood probe when the previous result is too old", async () => {
    const old = await seed();
    await upsertSection(env.DB, old, "flood", { status: "ok", method: "agent",
      checked_at: "2000-01-01T00:00:00.000Z", data: { flood_zone: "X" } });
    const id = await seed();
    const create = vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    expect(await startAgentSections(env, id, ["flood"])).toBe(1);
    expect(await section(id, "flood")).toMatchObject({ status: "pending" });
    expect(create).toHaveBeenCalledOnce();
  });
  it("finishes and posts the callback", async () => {
    const id = await seed();
    await env.DB.prepare("UPDATE dossiers SET callback_url = ? WHERE id = ?").bind("https://example.test/cb", id).run();
    for (const name of ["property", "zoning", "licenses_inspections", "deeds", "assessment_history", "schools", "flood"] as const)
      await upsertSection(env.DB, id, name, { status: "ok" });
    await upsertSection(env.DB, id, "tax", { status: "error" });
    fetchMock.activate();
    fetchMock.intercept({ url: "https://example.test/cb", method: "POST", reply: { status: 204 } });
    await finishAgentSections(env, id);
    expect(await getDossier(env.DB, id)).toMatchObject({ status: "complete", completed_at: expect.any(String) });
    expect(fetchMock.calls[0]!.body).toMatchObject({ dossier_id: id, status: "complete" });
  });
  it("enforces admin access and handles deepen states", async () => {
    const id = await seed("admin", "li_deep");
    const post = (target: string, admin = false) => callWorker(`/api/dossiers/${target}/deepen`, {
      method: "POST", headers: admin ? { Authorization: `Bearer ${env.ADMIN_TOKEN}` } : {},
    });
    expect((await post(id)).status).toBe(403);
    expect((await post("unknown", true)).status).toBe(404);
    expect((await post(id, true)).status).toBe(409);
    expect(await (await post(id, true)).json()).toMatchObject({ error: "in_progress" });
    await env.DB.prepare("UPDATE dossiers SET status = 'complete' WHERE id = ?").bind(id).run();
    await upsertSection(env.DB, id, "li_deep", { status: "ok" });
    expect((await post(id, true)).status).toBe(409);
    await upsertSection(env.DB, id, "li_deep", { status: "skipped" });
    vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    const response = await post(id, true);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ dossier_id: id, status: "partial", estimated_cost_usd: 0.224 });
  });

  it("does not reset an ok section or a pending section that already has a run", async () => {
    const id = await seed();
    await upsertSection(env.DB, id, "tax", { status: "ok", method: "agent", data: { balance_usd: 1 }, run_id: "kept" });
    await upsertSection(env.DB, id, "schools", { status: "pending", method: "agent", run_id: "live" });
    vi.spyOn(env.DOSSIER_WORKFLOW, "create").mockResolvedValue({} as never);
    expect(await startAgentSections(env, id, ["tax", "schools", "flood"])).toBe(1);
    expect(await section(id, "tax")).toMatchObject({ status: "ok", run_id: "kept", data: { balance_usd: 1 } });
    expect(await section(id, "schools")).toMatchObject({ status: "pending", run_id: "live" });
    expect(await section(id, "flood")).toMatchObject({ status: "pending", run_id: null });
  });
});

describe("evidence workflow steps", () => {
  const jpeg = (url: string) => {
    const bytes = new Uint8Array(12_000);
    bytes.set(new TextEncoder().encode(`\xff\xd8 jpeg of ${url}`));
    return bytes.buffer;
  };
  const shots: string[] = [];
  async function seedFree(extra: {
    completed_at?: string | null;
    workflow_id?: string | null;
    workflow_started_at?: string | null;
  } = {}) {
    const id = await insertDossier(env.DB, {
      tier: "free", status: "complete", added_by: "public", outcome: "resolved",
      opa_account: "111111111", address_resolved: "1 EXAMPLE ST",
      completed_at: extra.completed_at === undefined ? "2026-11-09T12:00:00.000Z" : extra.completed_at,
      workflow_id: extra.workflow_id === undefined ? null : extra.workflow_id,
      workflow_started_at: extra.workflow_started_at === undefined ? null : extra.workflow_started_at,
      spend_usd: 0,
    });
    for (const sid of FREE_SECTION_IDS) {
      await upsertSection(env.DB, id, sid, {
        status: "ok", method: "fetch", source_url: `https://atlas.phila.gov/1-EXAMPLE-ST/${sid}`,
      });
    }
    return id;
  }
  function recordingStep(on?: (name: string) => Promise<void> | void) {
    const calls: { name: string; config: object }[] = [];
    const step = {
      async do(name: string, config: object, callback: () => Promise<void>): Promise<void> {
        calls.push({ name, config });
        await on?.(name);
        await callback();
      },
      async sleep(): Promise<void> {},
    };
    return { calls, step };
  }
  beforeEach(() => {
    shots.length = 0;
    vi.spyOn(buildDeps, "screenshotFullPage").mockImplementation(async (_env, url) => {
      shots.push(url);
      return { bytes: jpeg(url), height: 800, sessionId: "s", settled: true };
    });
  });

  it("takes four screenshots as four named steps and stores four keys", async () => {
    const id = await seedFree();
    const { calls, step } = recordingStep();
    await runDossierSections(env, { dossierId: id, sections: [], evidence: true }, step);
    expect(calls.map((c) => c.name)).toEqual(FREE_SECTION_IDS.map((sid) => `evidence:${sid}`));
    for (const call of calls) {
      expect(call.config).toMatchObject({ retries: { limit: 0 }, timeout: "2 minutes" });
    }
    const sections = await getSections(env.DB, id);
    for (const sid of FREE_SECTION_IDS) {
      const row = sections.find((s) => s.section_id === sid)!;
      expect(row.evidence_key).toBe(`evidence/${id}/${sid}.jpg`);
      expect(row.spend_usd).toBe(PRICES.screenshot);
      expect(await env.STORE.get(row.evidence_key!)).not.toBeNull();
    }
    expect(shots).toHaveLength(4);
    expect((await getDossier(env.DB, id))!.spend_usd).toBe(0.008);
  });

  it("does not stop later screenshots when one step throws, and bills a thrown screenshot", async () => {
    const id = await seedFree();
    vi.mocked(buildDeps.screenshotFullPage).mockImplementation(async (_env, url) => {
      shots.push(url);
      if (url.endsWith("/zoning")) throw new TypeError("socket closed");
      return { bytes: jpeg(url), height: 800, sessionId: "s", settled: true };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, step } = recordingStep(async (name) => {
      if (name === "evidence:licenses_inspections") throw new Error("step timed out");
    });
    await runDossierSections(env, { dossierId: id, sections: [], evidence: true }, step);
    expect(calls.map((c) => c.name)).toEqual(FREE_SECTION_IDS.map((sid) => `evidence:${sid}`));
    const sections = await getSections(env.DB, id);
    expect(sections.find((s) => s.section_id === "property")!.evidence_key).toBe(`evidence/${id}/property.jpg`);
    expect(sections.find((s) => s.section_id === "zoning")!.evidence_key).toBeNull();
    expect(sections.find((s) => s.section_id === "licenses_inspections")!.evidence_key).toBeNull();
    expect(sections.find((s) => s.section_id === "deeds")!.evidence_key).toBe(`evidence/${id}/deeds.jpg`);
    expect((await getDossier(env.DB, id))!.spend_usd).toBe(0.006);
  });

  it("skips screenshots once total spend reaches the spend pause", async () => {
    const id = await seedFree();
    await recordSpend(env.DB, "agent_step", SPEND_PAUSE_USD, "seed");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { step } = recordingStep();
    await runDossierSections(env, { dossierId: id, sections: [], evidence: true }, step);
    expect(shots).toEqual([]);
    expect((await getSections(env.DB, id)).every((s) => s.evidence_key === null)).toBe(true);
    expect((await getDossier(env.DB, id))!.spend_usd).toBe(0);
  });

  it("does not run finish on an evidence-only instance and leaves completion fields untouched", async () => {
    const id = await seedFree({
      completed_at: "2026-11-09T12:00:00.000Z",
      workflow_id: "agent-wf",
      workflow_started_at: "2026-11-09T11:00:00.000Z",
    });
    const { calls, step } = recordingStep();
    await runDossierSections(env, { dossierId: id, sections: [], evidence: true }, step);
    expect(calls.map((c) => c.name)).not.toContain("finish");
    expect(await getDossier(env.DB, id)).toMatchObject({
      completed_at: "2026-11-09T12:00:00.000Z",
      workflow_id: "agent-wf",
      workflow_started_at: "2026-11-09T11:00:00.000Z",
    });
  });

  it("skips a section that already has evidence", async () => {
    const id = await seedFree();
    await upsertSection(env.DB, id, "property", { evidence_key: `evidence/${id}/property.jpg` });
    const { step } = recordingStep();
    await runDossierSections(env, { dossierId: id, sections: [], evidence: true }, step);
    expect(shots).toEqual(FREE_SECTION_IDS.filter((sid) => sid !== "property").map((sid) => `https://atlas.phila.gov/1-EXAMPLE-ST/${sid}`));
    expect((await getSections(env.DB, id)).find((s) => s.section_id === "property")!.evidence_key).toBe(`evidence/${id}/property.jpg`);
  });

  it("stores no evidence key for an unsettled capture or a tiny image, and still bills the session", async () => {
    const id = await seedFree();
    vi.mocked(buildDeps.screenshotFullPage).mockImplementation(async (_env, url) => {
      shots.push(url);
      if (url.endsWith("/property")) return { bytes: jpeg(url), height: 800, sessionId: "s", settled: false };
      if (url.endsWith("/zoning")) return { bytes: new Uint8Array(100).buffer, height: 800, sessionId: "s", settled: true };
      return { bytes: jpeg(url), height: 800, sessionId: "s", settled: true };
    });
    const { step } = recordingStep();
    await runDossierSections(env, { dossierId: id, sections: [], evidence: true }, step);
    const rows = await getSections(env.DB, id);
    expect(rows.find((s) => s.section_id === "property")).toMatchObject({ evidence_key: null, spend_usd: PRICES.screenshot });
    expect(rows.find((s) => s.section_id === "zoning")).toMatchObject({ evidence_key: null, spend_usd: PRICES.screenshot });
    expect(rows.find((s) => s.section_id === "licenses_inspections")!.evidence_key).toBe(`evidence/${id}/licenses_inspections.jpg`);
    expect(rows.find((s) => s.section_id === "deeds")!.evidence_key).toBe(`evidence/${id}/deeds.jpg`);
    expect((await getDossier(env.DB, id))!.spend_usd).toBe(0.008);
  });
});
