import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MAX_DURATION_SECONDS, AGENT_MAX_STEPS } from "../src/core/limits";
import { PRICES } from "../src/core/spend";
import { AGENT_SLOT_STALE_MS } from "../src/db/inflight";
import {
  AgentRunError,
  agentHoldBudgetMs,
  downloadStepScreenshot,
  getRun,
  pickEvidenceStep,
  POLL_TIMEOUT_MS,
  runAgentToCompletion,
  startRun,
} from "../src/tinyfish/agent";
import type { AgentStep, StartRunInput } from "../src/tinyfish/agent";
import { MIN_EVIDENCE_BYTES, screenshotFullPage } from "../src/tinyfish/browser";
import { LOADING_PLACEHOLDER } from "../src/tinyfish/fetch";
import { readJson, TinyFishError, tinyfishFetch } from "../src/tinyfish/client";
import { createMonitor, deleteMonitor, listMonitors, setMonitorStatus, updateMonitor } from "../src/tinyfish/monitor";
import { fetchMock } from "./helpers/fetch-mock";
import liDeep from "./fixtures/agent/li-deep.json";
import agentRun from "./fixtures/tinyfish/agent-run.json";
import browserCreate from "./fixtures/tinyfish/browser-create.json";
import monitorCreate from "./fixtures/tinyfish/monitor-create.json";
import monitorGet from "./fixtures/tinyfish/monitor-get.json";

const MONITORS_API = "https://agent.tinyfish.ai/v1/monitors";
const RUN_ASYNC_API = "https://agent.tinyfish.ai/v1/automation/run-async";
const RUNS_API = "https://agent.tinyfish.ai/v1/runs";
const BROWSER_API = "https://api.browser.tinyfish.ai";

const LI_URL = "https://li.phila.gov/property-history/search?address=1234%20MARKET%20ST";
const CALLBACK_URL = "https://groundwork.test/hooks/agent/s3cret";
const WATCH_PURPOSE = "A permit, inspection, violation, appeal or building certification was added or changed status.";

const START: StartRunInput = {
  url: LI_URL,
  goal: "Search the property history for 1234 Market St and return the lists.",
  outputSchema: { type: "object", properties: { permits_count: { type: "integer" } } },
};
const RATE_LIMITED = { status: 429, json: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many concurrent runs" } } };

type SpendRow = { kind: string; amount_usd: number; ref: string };

async function spendRows(): Promise<SpendRow[]> {
  const { results } = await env.DB.prepare("SELECT kind, amount_usd, ref FROM spend ORDER BY at, rowid").all<SpendRow>();
  return results;
}

function callsTo(method: string, url: string) {
  return fetchMock.calls.filter((c) => c.method === method && c.url === new URL(url).href);
}

const runUrl = (id: string, screenshots: "none" | "url") => `${RUNS_API}/${id}?screenshots=${screenshots}&html=none`;

/** The recorded run as `getRun(..., "url")` would return it: every step but the last has a screenshot URL. */
function withScreenshots(run: { run_id: string; steps: { id: string; status: string }[] }): Record<string, unknown> {
  return {
    ...run,
    steps: run.steps.map((s) => ({
      ...s,
      screenshot: s.status === "RUNNING" ? `https://agent.tinyfish.ai/runs/${run.run_id}/steps/${s.id}/screenshot` : null,
    })),
  };
}

/** A fake clock: `sleep` only moves it forward, so no test waits for real. */
function fakeClock() {
  let t = 0;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { sleep, now: () => t };
}

beforeEach(async () => {
  fetchMock.activate();
  await env.DB.prepare("DELETE FROM spend").run();
});
afterEach(() => {
  vi.useRealTimers();
  fetchMock.reset();
});

// ---------------------------------------------------------------------------
// client.ts
// ---------------------------------------------------------------------------

describe("tinyfishFetch", () => {
  it("sends the key and JSON content type, merges caller headers, and records spend on a 2xx", async () => {
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        expect(req.headers.get("Content-Type")).toBe("application/json");
        expect(req.headers.get("X-Caller")).toBe("kept");
        return Response.json({ ok: true });
      },
    });
    const res = await tinyfishFetch(env, BROWSER_API, {
      method: "POST",
      headers: { "X-Caller": "kept" },
      body: JSON.stringify({ url: LI_URL }),
      spend: { kind: "screenshot", amountUsd: 0.002, ref: LI_URL },
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: LI_URL }]);
  });

  it("returns the response and logs the kind only, instead of throwing, when the spend write fails after a 2xx", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: { session: "made" } } });
    const brokenDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await tinyfishFetch({ ...env, DB: brokenDb, TINYFISH_API_KEY: env.TINYFISH_API_KEY }, BROWSER_API, {
        method: "POST",
        body: "{}",
        spend: { kind: "screenshot", amountUsd: 0.002, ref: LI_URL },
      });
      expect(await res.json()).toEqual({ session: "made" });
      expect(logged).toHaveBeenCalledWith("spend write failed", "screenshot");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("test-tinyfish-key");
    } finally {
      logged.mockRestore();
    }
  });

  it("maps a 402 to TinyFishError INSUFFICIENT_CREDITS, with no response text in the message and no spend", async () => {
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      reply: { status: 402, json: { error: { code: "INSUFFICIENT_CREDITS", message: "Top up your account" } } },
    });
    const err = await tinyfishFetch(env, BROWSER_API, {
      method: "POST",
      body: "{}",
      spend: { kind: "screenshot", amountUsd: 0.002, ref: LI_URL },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 402, code: "INSUFFICIENT_CREDITS" });
    expect((err as Error).message).toBe("TinyFish HTTP 402 INSUFFICIENT_CREDITS");
    expect((err as Error).message).not.toContain("Top up your account");
    expect(await spendRows()).toEqual([]);
  });

  it("keeps whatever the response echoes (a rejected webhook url with its secret) out of the error message", async () => {
    const webhook = `https://groundwork.test/hooks/agent/${env.WEBHOOK_SECRET}`;
    const echoes = [
      { status: 400, json: { error: { code: "INVALID_WEBHOOK_URL", message: `webhook_url ${webhook} is not allowed` } } },
      { status: 400, json: { code: "BAD_INPUT", message: `rejected ${webhook}` } },
      { status: 400, json: { error: `rejected ${webhook}` } },
      { status: 502, body: `<html>upstream saw ${webhook}</html>` },
    ];
    const messages: string[] = [];
    for (const reply of echoes) {
      fetchMock.intercept({ method: "POST", url: BROWSER_API, reply });
      const err = await tinyfishFetch(env, BROWSER_API, { method: "POST", body: JSON.stringify({ webhook_url: webhook }) }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TinyFishError);
      messages.push((err as Error).message);
    }
    expect(messages).toEqual([
      "TinyFish HTTP 400 INVALID_WEBHOOK_URL",
      "TinyFish HTTP 400 BAD_INPUT",
      "TinyFish HTTP 400 http_400",
      "TinyFish HTTP 502 http_502",
    ]);
    expect(messages.join("\n")).not.toContain(env.WEBHOOK_SECRET);
  });

  it("uses an upstream error code only when it is a short token; anything else becomes http_<status>", async () => {
    const webhook = `https://groundwork.test/hooks/agent/${env.WEBHOOK_SECRET}`;
    const shapes: [unknown, string][] = [
      [{ error: { code: "RATE_LIMIT_EXCEEDED" } }, "RATE_LIMIT_EXCEEDED"],
      [{ error: { code: "a.b-c_9" } }, "a.b-c_9"],
      [{ error: { code: "x".repeat(64) } }, "x".repeat(64)],
      [{ error: { code: "x".repeat(65) } }, "http_400"],
      [{ error: { code: `rejected ${webhook}` } }, "http_400"],
      [{ error: { code: webhook } }, "http_400"],
      [{ error: { code: "bad\ncode" } }, "http_400"],
      [{ code: "has space" }, "http_400"],
    ];
    for (const [json, expected] of shapes) {
      fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { status: 400, json } });
      const err = await tinyfishFetch(env, BROWSER_API, { method: "POST" }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 400, code: expected });
      expect((err as Error).message).toBe(`TinyFish HTTP 400 ${expected}`);
      expect((err as Error).message).not.toContain(env.WEBHOOK_SECRET);
    }
  });

  it("readJson turns a 2xx body that is not JSON into a TinyFishError bad_json with none of the body in it", async () => {
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { status: 200, body: "<html>Maintenance, secret-page</html>" } });
    const res = await tinyfishFetch(env, MONITORS_API, { method: "GET" });
    const err = await readJson(res).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 200, code: "bad_json" });
    expect((err as Error).message).toBe("TinyFish HTTP 200 bad_json");
    expect((err as Error).message).not.toContain("secret-page");
  });
});

describe("tinyfishFetch rate-limit retry (opt-in)", () => {
  it("does not retry unless the caller asks: a 429 is thrown at once", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED });
    const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", sleep }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMIT_EXCEEDED" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits 60 s and retries on a 429, re-sending the same body; only the 2xx records spend", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 2 });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "r1" } } });
    const res = await tinyfishFetch(env, RUN_ASYNC_API, {
      method: "POST",
      body: JSON.stringify({ url: LI_URL }),
      retryRateLimit: true,
      sleep,
      spend: { kind: "agent_step", amountUsd: 0.016, ref: "run-1" },
    });
    expect(await res.json()).toEqual({ run_id: "r1" });
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]]);
    expect(callsTo("POST", RUN_ASYNC_API).map((c) => c.body)).toEqual([{ url: LI_URL }, { url: LI_URL }, { url: LI_URL }]);
    expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: 0.016, ref: "run-1" }]);
  });

  it("retries any 429, whatever its code or body, and ends in busy after four of them: four calls, three waits", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const anyLimit = [
      { status: 429, json: { error: { code: "QUOTA_EXCEEDED" } } },
      { status: 429, body: "slow down" },
      { status: 429, json: { error: "Too many requests" } },
    ];
    for (const limited of anyLimit) {
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: limited, times: 4 });
      const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", retryRateLimit: true, sleep }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TinyFishError);
      expect(err).toMatchObject({ status: 429, code: "busy" });
      expect((err as Error).message).toBe("TinyFish HTTP 429 busy");
    }
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(anyLimit.length * 4);
    expect(sleep).toHaveBeenCalledTimes(anyLimit.length * 3);
    expect(await spendRows()).toEqual([]);
  });

  it("does not retry a 400 or a 500, even with the option on", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const cases = [
      { reply: { status: 400, json: { error: { code: "INVALID_INPUT" } } }, code: "INVALID_INPUT", status: 400 },
      { reply: { status: 400, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } }, code: "RATE_LIMIT_EXCEEDED", status: 400 },
      { reply: { status: 500, body: "boom" }, code: "http_500", status: 500 },
    ];
    for (const c of cases) {
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: c.reply });
      const err = await tinyfishFetch(env, RUN_ASYNC_API, { method: "POST", body: "{}", retryRateLimit: true, sleep }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ status: c.status, code: c.code });
    }
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(cases.length);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// monitor.ts
// ---------------------------------------------------------------------------

describe("monitors", () => {
  const params = {
    url: "https://atlas.phila.gov/1234%20MARKET%20ST/li",
    name: "groundwork-li-883309050",
    scheduleCron: "7 1,13 * * *",
    purpose: WATCH_PURPOSE,
    webhookUrl: "https://groundwork.test/hooks/monitor/s3cret",
  };

  it("createMonitor returns monitorId and the baseline text from the 201 body, and records one monitor_check", async () => {
    fetchMock.intercept({
      method: "POST",
      url: MONITORS_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(monitorCreate, { status: 201 });
      },
    });
    const out = await createMonitor(env, params);
    expect(out.monitorId).toBe(monitorCreate.monitor.id);
    expect(out.baselineRunId).toBe(monitorCreate.run.id);
    expect(out.baselineText).toBe(monitorCreate.run.results[0]!.text);
    expect(out.baselineText.length).toBeGreaterThan(1000);
    expect(callsTo("POST", MONITORS_API)[0]!.body).toEqual({
      type: "fetch",
      name: params.name,
      config: { url: params.url, format: "markdown" },
      schedule_cron: "7 1,13 * * *",
      purpose: WATCH_PURPOSE,
      webhook_url: params.webhookUrl,
    });
    expect(await spendRows()).toEqual([{ kind: "monitor_check", amount_usd: 0.005, ref: params.url }]);
  });

  it("createMonitor deletes the new monitor and throws baseline_failed when the baseline has no text", async () => {
    const id = monitorCreate.monitor.id;
    const failed = { ...monitorCreate, run: { ...monitorCreate.run, results: [], errors: [{ url: params.url, error: "bot_blocked" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: failed } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 200, json: {} } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "baseline_failed" });
    // The orphan is gone: the one delete went to the monitor the 201 created.
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  it("createMonitor treats an empty baseline text as a failed baseline too, and still throws baseline_failed when the cleanup delete itself fails", async () => {
    const id = monitorCreate.monitor.id;
    const empty = { ...monitorCreate, run: { ...monitorCreate.run, results: [{ ...monitorCreate.run.results[0], text: "" }] } };
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: empty } });
    fetchMock.intercept({ method: "DELETE", url: `${MONITORS_API}/${id}`, reply: { status: 500, body: "boom" } });
    const err = await createMonitor(env, params).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "baseline_failed" });
    expect(callsTo("DELETE", `${MONITORS_API}/${id}`)).toHaveLength(1);
  });

  it("createMonitor reports a 201 that is not JSON as bad_json, and an answer with no monitor id as baseline_failed with nothing to delete", async () => {
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, body: "<html>ok</html>" } });
    await expect(createMonitor(env, params)).rejects.toMatchObject({ code: "bad_json" });
    fetchMock.intercept({ method: "POST", url: MONITORS_API, reply: { status: 201, json: {} } });
    await expect(createMonitor(env, params)).rejects.toMatchObject({ code: "baseline_failed" });
    expect(fetchMock.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("setMonitorStatus sends {status} alone and updateMonitor always includes schedule_cron", async () => {
    const id = monitorGet.id;
    const url = `${MONITORS_API}/${id}`;
    fetchMock.intercept({ method: "PATCH", url, reply: { json: monitorGet }, times: 5 });

    await setMonitorStatus(env, id, "paused");
    await updateMonitor(env, id, { scheduleCron: "0 */6 * * *" });
    await updateMonitor(env, id, {
      scheduleCron: "5 1,13 * * *",
      name: "New name",
      purpose: "New purpose",
      webhookUrl: "https://groundwork.test/hooks/monitor/new",
    });
    await updateMonitor(env, id, { scheduleCron: "5 1,13 * * *", webhookUrl: null });
    await setMonitorStatus(env, id, "active");

    expect(callsTo("PATCH", url).map((c) => c.body)).toEqual([
      { status: "paused" },
      { schedule_cron: "0 */6 * * *" },
      {
        schedule_cron: "5 1,13 * * *",
        name: "New name",
        purpose: "New purpose",
        webhook_url: "https://groundwork.test/hooks/monitor/new",
      },
      { schedule_cron: "5 1,13 * * *", webhook_url: null },
      { status: "active" },
    ]);
    expect(await spendRows()).toEqual([]);
  });

  it("deleteMonitor treats a 404 as already deleted and surfaces other failures", async () => {
    const url = `${MONITORS_API}/gone`;
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 500, body: "boom" } });
    await expect(deleteMonitor(env, "gone")).rejects.toMatchObject({ status: 500 });
    fetchMock.intercept({ method: "DELETE", url, reply: { status: 204 } });
    await expect(deleteMonitor(env, "gone")).resolves.toBeUndefined();
    expect(await spendRows()).toEqual([]);
  });

  it("listMonitors maps the account's monitors to id, status and name; a bare array works; anything else is empty", async () => {
    fetchMock.intercept({
      method: "GET",
      url: MONITORS_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({ monitors: [monitorGet, { id: "m2", status: "paused", name: null, config: {} }, { name: "no id" }, null] });
      },
    });
    expect(await listMonitors(env)).toEqual([
      { id: monitorGet.id, status: "active", name: "spike-fineprint" },
      { id: "m2", status: "paused", name: null },
    ]);

    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: [{ id: "m3" }] } });
    expect(await listMonitors(env)).toEqual([{ id: "m3", status: "unknown", name: null }]);
    fetchMock.intercept({ method: "GET", url: MONITORS_API, reply: { json: { total: 0 } } });
    expect(await listMonitors(env)).toEqual([]);
    expect(await spendRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// agent.ts: startRun
// ---------------------------------------------------------------------------

describe("agent: startRun", () => {
  it("posts the run with the schema, the standard profile and the caps, and returns the run id with no spend row", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json({ run_id: "run-1" });
      },
    });
    expect(await startRun(env, { ...START, callbackUrl: CALLBACK_URL })).toEqual({ runId: "run-1" });
    expect(AGENT_MAX_STEPS).toBe(14);
    expect(AGENT_MAX_DURATION_SECONDS).toBe(170);
    expect(callsTo("POST", RUN_ASYNC_API)[0]!.body).toEqual({
      url: LI_URL,
      goal: START.goal,
      browser_profile: "lite",
      agent_config: { max_steps: 14, max_duration_seconds: 170 },
      output_schema: START.outputSchema,
      webhook_url: CALLBACK_URL,
    });
    // Agent steps are billed when the run finishes, by the caller.
    expect(await spendRows()).toEqual([]);
  });

  it("sends no webhook_url at all when there is no callback (the Workflow polls)", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-2" } }, times: 2 });
    await startRun(env, START);
    await startRun(env, { ...START, callbackUrl: undefined });
    for (const call of callsTo("POST", RUN_ASYNC_API)) {
      expect(call.body).toEqual({
        url: LI_URL,
        goal: START.goal,
        browser_profile: "lite",
        agent_config: { max_steps: 14, max_duration_seconds: 170 },
        output_schema: START.outputSchema,
      });
      expect(Object.keys(call.body as object)).not.toContain("webhook_url");
    }
  });

  it("never asks for any other browser profile: the body is lite, and the word is nowhere in the source", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-3" } } });
    await startRun(env, { ...START, callbackUrl: CALLBACK_URL });
    const body = callsTo("POST", RUN_ASYNC_API)[0]!.body as { browser_profile: string };
    expect(body.browser_profile).toBe("lite");
    expect(JSON.stringify(body)).not.toMatch(/stealth/i);

    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /stealth/i.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("throws no_run_id when the answer has no run_id", async () => {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: {} } });
    const err = await startRun(env, START).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ code: "no_run_id" });
  });

  it("429 then 201: one run id after one 60 s wait (the default wait is a real timer, driven here by fake ones)", async () => {
    vi.useFakeTimers();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 201, json: { run_id: "run-4" } } });

    let settled = false;
    const started = startRun(env, START).then((out) => {
      settled = true;
      return out;
    });
    await vi.waitFor(() => expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await started).toEqual({ runId: "run-4" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
  });

  it("three 429s then a 200 return the run id after 4 calls and three 60 s waits; four 429s fail with code busy", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 3 });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: "run-5" } } });
    expect(await startRun(env, START, { sleep })).toEqual({ runId: "run-5" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000], [60_000]]);

    sleep.mockClear();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 4 });
    const err = await startRun(env, START, { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toMatchObject({ status: 429, code: "busy" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(8);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400 or a 500", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 400, json: { error: { code: "INVALID_INPUT" } } } });
    expect(await startRun(env, START, { sleep }).catch((e: unknown) => e)).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 500, body: "boom" } });
    expect(await startRun(env, START, { sleep }).catch((e: unknown) => e)).toMatchObject({ status: 500, code: "http_500" });
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps the callback url (it holds the webhook secret) out of the error when a start is rejected", async () => {
    fetchMock.intercept({
      method: "POST",
      url: RUN_ASYNC_API,
      reply: { status: 400, json: { error: { code: "INVALID_WEBHOOK_URL", message: `bad ${CALLBACK_URL}` } } },
    });
    const err = await startRun(env, { ...START, callbackUrl: CALLBACK_URL }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVALID_WEBHOOK_URL" });
    expect((err as Error).message).not.toContain("s3cret");
  });
});

// ---------------------------------------------------------------------------
// agent.ts: getRun
// ---------------------------------------------------------------------------

describe("agent: getRun", () => {
  it("asks for screenshot urls and returns status, result, step count, finish time, error and steps", async () => {
    const id = agentRun.run_id;
    fetchMock.intercept({
      method: "GET",
      url: runUrl(id, "url"),
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return Response.json(agentRun);
      },
    });
    const run = await getRun(env, id, "url");
    expect(run).toMatchObject({
      status: "COMPLETED",
      result: agentRun.result,
      num_of_steps: 5,
      finished_at: "2026-11-03T07:35:31Z",
      error: null,
    });
    expect(run.steps).toHaveLength(agentRun.steps.length);
    expect(run.steps[2]).toEqual({
      id: "c7ac9dab-32a2-4a5f-805e-60044388796c",
      action: "Scroll to the bottom of the page",
      screenshot:
        "https://agent.tinyfish.ai/runs/601b2055-946e-4057-b445-74d2fc25b9e4/steps/c7ac9dab-32a2-4a5f-805e-60044388796c/screenshot",
    });
    expect(run.steps.at(-1)).toEqual({ id: "15109165-e489-4209-8ba9-b71a16e24663", action: "Task completed", screenshot: null });
    expect(await spendRows()).toEqual([]);
  });

  it("asks for no screenshots with 'none' and reads the recorded Groundwork run: 9 steps, none with a screenshot", async () => {
    fetchMock.intercept({ method: "GET", url: runUrl(liDeep.run_id, "none"), reply: { json: liDeep } });
    const run = await getRun(env, liDeep.run_id, "none");
    expect(run.status).toBe("COMPLETED");
    expect(run.num_of_steps).toBe(9);
    expect(run.finished_at).toBe("2026-11-03T10:31:56Z");
    expect(run.result).toEqual(liDeep.result);
    expect(run.steps).toHaveLength(10);
    expect(run.steps.every((s) => s.screenshot === null)).toBe(true);
  });

  it("tolerates a bare running run, and drops steps without an id", async () => {
    fetchMock.intercept({ method: "GET", url: runUrl("r2", "none"), reply: { json: { run_id: "r2", status: "RUNNING" } } });
    expect(await getRun(env, "r2", "none")).toEqual({
      status: "RUNNING",
      result: null,
      num_of_steps: null,
      finished_at: null,
      error: null,
      steps: [],
    });

    fetchMock.intercept({
      method: "GET",
      url: runUrl("r3", "url"),
      reply: { json: { status: "RUNNING", steps: [null, { action: "no id" }, { id: "s1", action: 5, screenshot: 7 }, { id: "s2" }] } },
    });
    expect((await getRun(env, "r3", "url")).steps).toEqual([
      { id: "s1", action: null, screenshot: null },
      { id: "s2", action: null, screenshot: null },
    ]);
  });

  it("reads a failed run's error as text, from a string or an object", async () => {
    fetchMock.intercept({ method: "GET", url: runUrl("f1", "none"), reply: { json: { status: "FAILED", error: "Target blocked" } } });
    expect((await getRun(env, "f1", "none")).error).toBe("Target blocked");
    fetchMock.intercept({
      method: "GET",
      url: runUrl("f2", "none"),
      reply: { json: { status: "FAILED", error: { code: "TARGET_BLOCKED", message: "Blocked by the site" } } },
    });
    expect((await getRun(env, "f2", "none")).error).toBe("Blocked by the site");
    fetchMock.intercept({ method: "GET", url: runUrl("f3", "none"), reply: { json: { status: "FAILED", error: { code: "TIMEOUT" } } } });
    expect((await getRun(env, "f3", "none")).error).toBe("TIMEOUT");
    fetchMock.intercept({ method: "GET", url: runUrl("f4", "none"), reply: { json: { status: "FAILED", error: { odd: true } } } });
    expect((await getRun(env, "f4", "none")).error).toBe("agent_error");
  });

  it("puts the run id in the path encoded", async () => {
    fetchMock.intercept({ method: "GET", url: /^https:\/\/agent\.tinyfish\.ai\/v1\/runs\/a%2Fb\?/, reply: { json: { status: "RUNNING" } } });
    await getRun(env, "a/b", "none");
    expect(fetchMock.calls[0]!.url).toContain("/v1/runs/a%2Fb?screenshots=none&html=none");
  });
});

// ---------------------------------------------------------------------------
// agent.ts: downloadStepScreenshot
// ---------------------------------------------------------------------------

describe("agent: downloadStepScreenshot", () => {
  // The first bytes of a JPEG; the content is not decoded anywhere.
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const stepUrl = (runId: string, stepId: string) => `${RUNS_API}/${runId}/steps/${stepId}/screenshot`;

  it("GETs the API-key binary endpoint (with the /v1 prefix) and returns the image bytes, with no spend row", async () => {
    const runId = agentRun.run_id;
    const stepId = "c7ac9dab-32a2-4a5f-805e-60044388796c";
    fetchMock.intercept({
      method: "GET",
      url: stepUrl(runId, stepId),
      reply: (req) => {
        expect(req.headers.get("X-API-Key")).toBe("test-tinyfish-key");
        return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
      },
    });
    const bytes = await downloadStepScreenshot(env, runId, stepId);
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(bytes))).toEqual(Array.from(JPEG));
    expect(fetchMock.calls[0]!.url).toBe(`https://agent.tinyfish.ai/v1/runs/${runId}/steps/${stepId}/screenshot`);
    // The step is already paid for in the run's steps.
    expect(await spendRows()).toEqual([]);
  });

  it("throws when the answer is not an image, or is empty, and carries none of the page text", async () => {
    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: { status: 200, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" },
    });
    const notImage = await downloadStepScreenshot(env, "r", "s").catch((e: unknown) => e);
    expect(notImage).toBeInstanceOf(TinyFishError);
    expect(notImage).toMatchObject({ code: "not_an_image" });
    expect((notImage as Error).message).not.toContain("Sign in");

    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: { status: 200, headers: { "content-type": "application/json" }, json: { error: "x" } },
    });
    await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ code: "not_an_image" });

    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: { status: 200, headers: { "content-type": "image/jpeg" }, body: "" },
    });
    await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ code: "empty_image" });
  });

  it("surfaces an HTTP error as a TinyFishError", async () => {
    fetchMock.intercept({ method: "GET", url: stepUrl("r", "s"), reply: { status: 404, json: { error: { code: "NOT_FOUND" } } } });
    await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("aborts a hung screenshot download after POLL_TIMEOUT_MS", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(POLL_TIMEOUT_MS);
      return realTimeout(20);
    });
    fetchMock.intercept({
      method: "GET",
      url: stepUrl("r", "s"),
      reply: (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason));
        }),
    });
    try {
      await expect(downloadStepScreenshot(env, "r", "s")).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// agent.ts: pickEvidenceStep
// ---------------------------------------------------------------------------

describe("agent: pickEvidenceStep", () => {
  /** Steps with a screenshot URL each, named by their action. */
  const shots = (...actions: (string | null)[]): AgentStep[] =>
    actions.map((action, i) => ({ id: `s${i}`, action, screenshot: `https://x/s${i}` }));

  const stepIdByAction = (prefix: string) => liDeep.steps.find((s) => s.action.startsWith(prefix))!.id;

  it("is null for the Groundwork run as recorded (read without screenshots), and for no steps", () => {
    expect(pickEvidenceStep(liDeep)).toBeNull();
    expect(pickEvidenceStep({ steps: [] })).toBeNull();
    expect(pickEvidenceStep({ steps: [{ id: "a", action: null, screenshot: null }] })).toBeNull();
  });

  it("picks the last step that shows the property history, not the search form or the step that returns the answer", async () => {
    // The same run read with screenshots=url: every step but the last has an image.
    fetchMock.intercept({ method: "GET", url: runUrl(liDeep.run_id, "url"), reply: { json: withScreenshots(liDeep) } });
    const run = await getRun(env, liDeep.run_id, "url");
    expect(run.steps.filter((s) => s.screenshot !== null)).toHaveLength(9);

    const picked = pickEvidenceStep(run);
    expect(picked).toBe(stepIdByAction("Check for licenses and appeals sections"));
    for (const form of [
      "Navigate to property history search page",
      "Enter the property address to search",
      "Submit the address search",
      "Return search results",
    ]) {
      expect(picked).not.toBe(stepIdByAction(form));
    }
  });

  it("picks the step that shows the result on the other Agent pages", () => {
    const tax = shots(
      "Navigate to the real estate tax search page",
      "Enter the OPA account number",
      "Click the search button",
      "Open the property's balance details",
      "Extract the total balance due",
      "Return the balance as JSON",
    );
    expect(pickEvidenceStep({ steps: tax })).toBe("s4");

    const schools = shots(
      "Navigate to the school finder",
      "Enter the address in the search box",
      "Submit the address",
      "View the catchment school list",
      "Read the elementary, middle and high school names",
      "Return the schools",
    );
    expect(pickEvidenceStep({ steps: schools })).toBe("s4");

    const flood = shots(
      "Navigate to the FEMA flood map search",
      "Enter the address in the search field",
      "Click the search button",
      "Read the flood hazard result: no results found",
      "Return the flood zone or no results",
    );
    expect(pickEvidenceStep({ steps: flood })).toBe("s3");

    const assessment = shots(
      "Navigate to the property page",
      "Scroll to the assessment history table",
      "Expand the assessment history",
      "Extract assessed value, market value and tax year for each year",
    );
    expect(pickEvidenceStep({ steps: assessment })).toBe("s3");
  });

  it("does not take a banner, a back step or a results count as the evidence", () => {
    expect(pickEvidenceStep({ steps: shots("Extract permit details", "Close the cookie banner", "Check for a cookie dialog") })).toBe("s0");
    expect(pickEvidenceStep({ steps: shots("Open the violations history", "Go back to the search form", "Count the search results") })).toBe(
      "s0",
    );
    expect(pickEvidenceStep({ steps: shots("Read the balance", "Return search results and balance details") })).toBe("s0");
  });

  it("does not mistake real result steps for the way out: a permit 'type', 'closed' violations, a 'count', a table that must 'load'", () => {
    const lead = ["Navigate to property history search page", "Enter the property address to search", "Submit the address search"];
    const resultSteps = [
      "Extract the permit type, status and date",
      "Extract closed violations from the table",
      "Extract the permit count",
      "Wait for the assessment history table to load",
    ];
    for (const action of resultSteps) {
      // The result step comes last before the answer is returned, so it must win over everything before it.
      expect(pickEvidenceStep({ steps: shots(...lead, "Extract details of the property", action, "Return the answer as JSON") }), action).toBe("s4");
    }
  });

  it("still leaves out the verb 'type' (typing the address), counting search results, and waiting for a search", () => {
    for (const action of [
      "Type the permit number into the search field",
      "Typing the permit address",
      "Enter the address and type the permit number",
      "Count the permit search results",
      "Count the number of permit results",
      "Wait for the permit search results to load",
      "Wait for the search to finish and show permits",
    ]) {
      expect(pickEvidenceStep({ steps: shots("Extract permit details", action) }), action).toBe("s0");
    }
    // 'type' as a noun and 'closed' as a status are data, not form actions.
    expect(pickEvidenceStep({ steps: shots("Open the violations table", "Read the type of each permit") })).toBe("s1");
  });

  it("falls back to the last step with a screenshot when no action reads a result", () => {
    const steps = [...shots("Navigate to the register", "Enter the name", "Press search"), { id: "d", action: "Task completed", screenshot: null }];
    expect(pickEvidenceStep({ steps })).toBe("s2");
    // Only steps that go back or return: the last of them.
    expect(pickEvidenceStep({ steps: shots("Go back to search results page", "Return search results and details") })).toBe("s1");
  });

  it("skips a result step that has no screenshot and takes the last one that does", () => {
    const steps: AgentStep[] = [
      { id: "a", action: "Open the permit history", screenshot: "https://x/a" },
      { id: "b", action: "Read the permit history table", screenshot: "https://x/b" },
      { id: "c", action: "Read the violations on the page", screenshot: null },
      { id: "d", action: "Wait for the page", screenshot: "https://x/d" },
    ];
    expect(pickEvidenceStep({ steps })).toBe("b");
  });

  it("reads a step with no action text as a screenshot only", () => {
    const steps: AgentStep[] = [
      { id: "a", action: "Extract details", screenshot: "https://x/a" },
      { id: "b", action: null, screenshot: "https://x/b" },
    ];
    expect(pickEvidenceStep({ steps })).toBe("a");
    expect(pickEvidenceStep({ steps: [{ id: "b", action: null, screenshot: "https://x/b" }] })).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// agent.ts: runAgentToCompletion
// ---------------------------------------------------------------------------

describe("agent: runAgentToCompletion", () => {
  const RUN_ID = liDeep.run_id;
  const running = { run_id: RUN_ID, status: "RUNNING", num_of_steps: 3, steps: [] };

  function interceptStart(runId = RUN_ID) {
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: { run_id: runId } } });
  }

  it("starts a run with the section's own step limit when it has one, and the common limit otherwise", async () => {
    const { sleep, now } = fakeClock();
    for (const [input, steps] of [[{ ...START, maxSteps: 6 }, 6], [START, 14]] as const) {
      fetchMock.reset();
      fetchMock.activate();
      interceptStart();
      fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
      fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });
      await runAgentToCompletion(env, input, { pollEveryMs: 5_000, maxWaitMs: 200_000, sleep, now });
      const start = fetchMock.calls.find((c) => c.method === "POST")!;
      expect((start.body as { agent_config: { max_steps: number } }).agent_config.max_steps).toBe(steps);
    }
  });

  it("polls until COMPLETED, reads the screenshots once, and records exactly one agent_step row of 9 steps", async () => {
    const { sleep, now } = fakeClock();
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: running }, times: 2 });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });

    const out = await runAgentToCompletion(env, START, { pollEveryMs: 5_000, maxWaitMs: 200_000, sleep, now });

    expect(out.runId).toBe(RUN_ID);
    expect(out.status).toBe("COMPLETED");
    expect(out.result).toEqual(liDeep.result);
    expect(out.numOfSteps).toBe(9);
    expect(out.error).toBeNull();
    expect(out.finishedAt).toBe("2026-11-03T10:31:56Z");
    // The caller gets the step screenshot URLs.
    expect(out.steps).toHaveLength(10);
    expect(out.steps.filter((s) => s.screenshot !== null)).toHaveLength(9);
    expect(out.steps[0]).toEqual({
      id: liDeep.steps[0]!.id,
      action: "Navigate to property history search page",
      screenshot: `https://agent.tinyfish.ai/runs/${RUN_ID}/steps/${liDeep.steps[0]!.id}/screenshot`,
    });

    // One start, three polls without screenshots (a wait before each), then one read with them.
    expect(fetchMock.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${RUN_ASYNC_API}`,
      `GET ${runUrl(RUN_ID, "none")}`,
      `GET ${runUrl(RUN_ID, "none")}`,
      `GET ${runUrl(RUN_ID, "none")}`,
      `GET ${runUrl(RUN_ID, "url")}`,
    ]);
    expect(sleep.mock.calls).toEqual([[5_000], [5_000], [5_000]]);
    expect(callsTo("POST", RUN_ASYNC_API)[0]!.body).toMatchObject({ browser_profile: "lite" });
    expect(Object.keys(callsTo("POST", RUN_ASYNC_API)[0]!.body as object)).not.toContain("webhook_url");

    // Exactly one spend row for the run: 9 steps at the Agent price, ref the run id.
    // The amount is rounded to 6 decimals: 0.144, not 9 * 0.016 = 0.14400000000000002.
    expect(9 * PRICES.agent_step).not.toBe(0.144);
    expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: 0.144, ref: RUN_ID }]);
  });

  it("works with the real clock and the real wait: a short poll interval, no injected sleep or now", async () => {
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: running }, times: 2 });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });
    const out = await runAgentToCompletion(env, START, { pollEveryMs: 1, maxWaitMs: 10_000 });
    expect(out.status).toBe("COMPLETED");
    expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(3);
    expect(await spendRows()).toHaveLength(1);
  });

  it("returns a run that finishes on the very poll at the deadline, not a timeout", async () => {
    const { sleep, now } = fakeClock();
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: running } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });
    const out = await runAgentToCompletion(env, START, { pollEveryMs: 5_000, maxWaitMs: 10_000, sleep, now });
    expect(out.status).toBe("COMPLETED");
    expect(await spendRows()).toHaveLength(1);
  });

  it("bills a FAILED run for the steps it took and returns its error", async () => {
    const { sleep, now } = fakeClock();
    const failed = {
      run_id: "run-f",
      status: "FAILED",
      num_of_steps: 4,
      finished_at: "2026-11-03T11:00:00Z",
      result: null,
      error: { code: "TARGET_BLOCKED", message: "Blocked by the site" },
      steps: [{ id: "x1", action: "Navigate to the page", status: "RUNNING", screenshot: null }],
    };
    interceptStart("run-f");
    fetchMock.intercept({ method: "GET", url: runUrl("run-f", "none"), reply: { json: failed } });
    fetchMock.intercept({ method: "GET", url: runUrl("run-f", "url"), reply: { json: failed } });

    const out = await runAgentToCompletion(env, START, { pollEveryMs: 1_000, maxWaitMs: 30_000, sleep, now });
    expect(out).toMatchObject({ runId: "run-f", status: "FAILED", result: null, numOfSteps: 4, error: "Blocked by the site" });
    expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: 0.064, ref: "run-f" }]);
  });

  it("bills a CANCELLED run too, and treats nothing else as terminal", async () => {
    const { sleep, now } = fakeClock();
    interceptStart("run-c");
    fetchMock.intercept({ method: "GET", url: runUrl("run-c", "none"), reply: { json: { run_id: "run-c", status: "PENDING" } } });
    fetchMock.intercept({ method: "GET", url: runUrl("run-c", "none"), reply: { json: { run_id: "run-c", status: "QUEUED", num_of_steps: 0 } } });
    fetchMock.intercept({ method: "GET", url: runUrl("run-c", "none"), reply: { json: { run_id: "run-c", status: "CANCELLED", num_of_steps: 2 } } });
    fetchMock.intercept({ method: "GET", url: runUrl("run-c", "url"), reply: { json: { run_id: "run-c", status: "CANCELLED", num_of_steps: 2 } } });
    const out = await runAgentToCompletion(env, START, { pollEveryMs: 1_000, maxWaitMs: 30_000, sleep, now });
    expect(out.status).toBe("CANCELLED");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: 0.032, ref: "run-c" }]);
  });

  it("writes no spend row for a terminal run with zero steps, or one that reports no step count", async () => {
    const { sleep, now } = fakeClock();
    for (const [runId, extra] of [
      ["run-z0", { num_of_steps: 0 }],
      ["run-zn", {}],
    ] as const) {
      const body = { run_id: runId, status: "FAILED", error: "Target blocked", ...extra };
      interceptStart(runId);
      fetchMock.intercept({ method: "GET", url: runUrl(runId, "none"), reply: { json: body } });
      fetchMock.intercept({ method: "GET", url: runUrl(runId, "url"), reply: { json: body } });
      const out = await runAgentToCompletion(env, START, { pollEveryMs: 1_000, maxWaitMs: 30_000, sleep, now });
      expect(out.status).toBe("FAILED");
    }
    expect(await spendRows()).toEqual([]);
  });

  it("throws agent_timeout when the run is still going after maxWaitMs, and records no spend", async () => {
    const { sleep, now } = fakeClock();
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: running }, times: Infinity });

    const err = await runAgentToCompletion(env, START, { pollEveryMs: 5_000, maxWaitMs: 20_000, sleep, now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err).toMatchObject({ status: 504, code: "agent_timeout", phase: "timeout", runId: RUN_ID });
    expect((err as Error).message).toContain("agent_timeout");
    expect((err as Error).message).toContain(RUN_ID);
    // Polls at 5, 10, 15 and 20 s; the 20 s poll is the last (it found the run still going).
    expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(4);
    expect(callsTo("GET", runUrl(RUN_ID, "url"))).toHaveLength(0);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(await spendRows()).toEqual([]);
  });

  it("does not count the 60 s waits of a rate-limited start against maxWaitMs; three 429s then success", async () => {
    const { sleep, now } = fakeClock();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 3 });
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: running } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });

    // 180 s of waiting before the run exists; the run then gets its own 12 s, and uses 10.
    const out = await runAgentToCompletion(env, START, { pollEveryMs: 5_000, maxWaitMs: 12_000, sleep, now });
    expect(out.status).toBe("COMPLETED");
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000], [60_000], [5_000], [5_000]]);
    expect(await spendRows()).toHaveLength(1);
  });

  it("fails with code busy after four 429s, starts nothing, polls nothing and records no spend", async () => {
    const { sleep, now } = fakeClock();
    fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: RATE_LIMITED, times: 4 });
    const err = await runAgentToCompletion(env, START, { pollEveryMs: 5_000, maxWaitMs: 30_000, sleep, now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TinyFishError);
    expect(err).toBeInstanceOf(AgentRunError);
    // No run exists: phase "start", no run id, the code and message are the client's own.
    expect(err).toMatchObject({ status: 429, code: "busy", phase: "start", runId: null });
    expect((err as Error).message).toBe("TinyFish HTTP 429 busy");
    expect(callsTo("POST", RUN_ASYNC_API)).toHaveLength(4);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000], [60_000]]);
    expect(fetchMock.calls.filter((c) => c.method === "GET")).toEqual([]);
    expect(await spendRows()).toEqual([]);
  });

  it("still returns the paid-for result, steps without screenshots, when the screenshot read fails", async () => {
    const { sleep, now } = fakeClock();
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { status: 500, body: "boom" } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runAgentToCompletion(env, START, { pollEveryMs: 5_000, maxWaitMs: 30_000, sleep, now });
      expect(out).toMatchObject({ runId: RUN_ID, status: "COMPLETED", numOfSteps: 9, result: liDeep.result });
      expect(out.steps).toHaveLength(10);
      expect(out.steps.every((s) => s.screenshot === null)).toBe(true);
      expect(logged).toHaveBeenCalledWith("agent screenshot read failed", "TinyFishError");
      expect(JSON.stringify(logged.mock.calls)).not.toContain("test-tinyfish-key");
    } finally {
      logged.mockRestore();
    }
    expect(await spendRows()).toHaveLength(1);
  });

  it("returns the result when the spend write fails, and logs the kind and the run id", async () => {
    const { sleep, now } = fakeClock();
    interceptStart();
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: { json: liDeep } });
    fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });
    const brokenDb = {
      prepare() {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runAgentToCompletion({ ...env, DB: brokenDb, TINYFISH_API_KEY: env.TINYFISH_API_KEY }, START, {
        pollEveryMs: 5_000,
        maxWaitMs: 30_000,
        sleep,
        now,
      });
      expect(out.status).toBe("COMPLETED");
      // The kind and the run id (not a secret) are logged, nothing else.
      expect(logged).toHaveBeenCalledWith("spend write failed", "agent_step", RUN_ID);
      expect(JSON.stringify(logged.mock.calls)).not.toContain("test-tinyfish-key");
    } finally {
      logged.mockRestore();
    }
  });

  // --- every failure is an AgentRunError that says whether a run exists --------------------------

  describe("failures: AgentRunError with phase and run id", () => {
    const opts = (clock: ReturnType<typeof fakeClock>, extra: Record<string, unknown> = {}) => ({
      pollEveryMs: 5_000,
      maxWaitMs: 200_000,
      sleep: clock.sleep,
      now: clock.now,
      ...extra,
    });
    const pollNone = (reply: object, times = 1) =>
      fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: reply as never, times });
    const completed = () => {
      pollNone({ json: liDeep });
      fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "url"), reply: { json: withScreenshots(liDeep) } });
    };

    it("a start failure is phase start with no run id, whatever its cause, and keeps the client's code", async () => {
      const clock = fakeClock();
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 400, json: { error: { code: "INVALID_INPUT", message: `bad ${CALLBACK_URL}` } } } });
      const rejected = await runAgentToCompletion(env, { ...START, callbackUrl: CALLBACK_URL }, opts(clock)).catch((e: unknown) => e);
      expect(rejected).toBeInstanceOf(AgentRunError);
      expect(rejected).toMatchObject({ status: 400, code: "INVALID_INPUT", phase: "start", runId: null });
      expect((rejected as Error).message).not.toContain("s3cret");

      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { json: {} } });
      expect(await runAgentToCompletion(env, START, opts(clock)).catch((e: unknown) => e)).toMatchObject({
        code: "no_run_id",
        phase: "start",
        runId: null,
      });

      fetchMock.intercept({
        method: "POST",
        url: RUN_ASYNC_API,
        reply: () => {
          throw new TypeError("fetch failed: https://secret.example.test/hook");
        },
      });
      const network = await runAgentToCompletion(env, START, opts(clock)).catch((e: unknown) => e);
      expect(network).toBeInstanceOf(AgentRunError);
      expect(network).toMatchObject({ status: 0, code: "network_error", phase: "start", runId: null });
      expect((network as Error).message).toBe("TinyFish start failed: TypeError");
      expect(fetchMock.calls.filter((c) => c.method === "GET")).toEqual([]);
      expect(await spendRows()).toEqual([]);
    });

    it("onStarted is called once, with the run id, before the first poll", async () => {
      const clock = fakeClock();
      interceptStart();
      completed();
      const seen: { id: string; callsSoFar: string[] }[] = [];
      const out = await runAgentToCompletion(env, START, {
        ...opts(clock),
        onStarted: async (id) => {
          seen.push({ id, callsSoFar: fetchMock.calls.map((c) => c.method) });
        },
      });
      expect(out.status).toBe("COMPLETED");
      expect(seen).toEqual([{ id: RUN_ID, callsSoFar: ["POST"] }]);
    });

    it("onStarted is not called when the start fails; an error thrown by it is logged by name and the run goes on", async () => {
      const clock = fakeClock();
      const onStarted = vi.fn(async (_id: string) => {});
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: { status: 500, body: "boom" } });
      await expect(runAgentToCompletion(env, START, { ...opts(clock), onStarted })).rejects.toMatchObject({ phase: "start" });
      expect(onStarted).not.toHaveBeenCalled();

      interceptStart();
      completed();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await runAgentToCompletion(env, START, {
          ...opts(clock),
          onStarted: async () => {
            throw new Error("D1 is down: secret-detail");
          },
        });
        expect(out.status).toBe("COMPLETED");
        expect(logged).toHaveBeenCalledWith("agent onStarted failed", "Error");
        expect(JSON.stringify(logged.mock.calls)).not.toContain("secret-detail");
      } finally {
        logged.mockRestore();
      }
    });

    it("one 503 on a poll is retried at the normal interval, then the run completes and is billed once", async () => {
      const clock = fakeClock();
      interceptStart();
      pollNone({ status: 503, body: "down" });
      completed();
      const out = await runAgentToCompletion(env, START, opts(clock));
      expect(out).toMatchObject({ runId: RUN_ID, status: "COMPLETED", numOfSteps: 9 });
      expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(2);
      expect(clock.sleep.mock.calls).toEqual([[5_000], [5_000]]);
      expect(await spendRows()).toEqual([{ kind: "agent_step", amount_usd: 0.144, ref: RUN_ID }]);
    });

    it("retries each transient kind of poll failure: 429, 500, a 200 that is not JSON, a network error, a hung request", async () => {
      type Reply = Parameters<typeof fetchMock.intercept>[0]["reply"];
      const kinds: [string, Reply][] = [
        ["429", { status: 429, json: { error: { code: "RATE_LIMIT_EXCEEDED" } } }],
        ["500", { status: 500, body: "boom" }],
        ["bad_json", { status: 200, body: "<html>Maintenance</html>" }],
        [
          "network",
          () => {
            throw new TypeError("fetch failed");
          },
        ],
        [
          "hung",
          (req) =>
            new Promise<Response>((_resolve, reject) => {
              req.signal.addEventListener("abort", () => reject(req.signal.reason));
            }),
        ],
      ];
      let polls = 0;
      for (const [kind, reply] of kinds) {
        const clock = fakeClock();
        await env.DB.prepare("DELETE FROM spend").run();
        interceptStart();
        fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply });
        completed();
        // A 20 ms request timeout makes the hung poll fail fast; the others ignore it.
        const out = await runAgentToCompletion(env, START, opts(clock, { pollTimeoutMs: 20 }));
        polls += 2;
        expect(out.status, kind).toBe("COMPLETED");
        expect(callsTo("GET", runUrl(RUN_ID, "none")), kind).toHaveLength(polls);
        expect(await spendRows(), kind).toHaveLength(1);
      }
    });

    it("gives up at once on a 4xx other than 429: phase poll, the run id, the client's code", async () => {
      for (const status of [400, 401, 403, 404]) {
        const clock = fakeClock();
        interceptStart();
        pollNone({ status, json: { error: { code: "NOT_FOUND" } } });
        const err = await runAgentToCompletion(env, START, opts(clock)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AgentRunError);
        expect(err).toMatchObject({ status, code: "NOT_FOUND", phase: "poll", runId: RUN_ID });
        expect((err as Error).message).toContain(RUN_ID);
        expect(clock.sleep).toHaveBeenCalledTimes(1);
      }
      expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(4);
      expect(await spendRows()).toEqual([]);
    });

    it("four consecutive poll failures give up with phase poll and the run id; no spend row", async () => {
      const clock = fakeClock();
      interceptStart();
      pollNone({ status: 503, body: "down" }, 4);
      const err = await runAgentToCompletion(env, START, opts(clock)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentRunError);
      expect(err).toBeInstanceOf(TinyFishError);
      expect(err).toMatchObject({ status: 503, code: "http_503", phase: "poll", runId: RUN_ID });
      // Four polls, each after a normal wait; no screenshot read; nothing billed.
      expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(4);
      expect(callsTo("GET", runUrl(RUN_ID, "url"))).toHaveLength(0);
      expect(clock.sleep.mock.calls).toEqual([[5_000], [5_000], [5_000], [5_000]]);
      expect(await spendRows()).toEqual([]);
    });

    it("a network failure that keeps happening ends as network_error, phase poll, with the error's name only", async () => {
      const clock = fakeClock();
      interceptStart();
      fetchMock.intercept({
        method: "GET",
        url: runUrl(RUN_ID, "none"),
        reply: () => {
          throw new TypeError("fetch failed: https://secret.example.test/hook");
        },
        times: 4,
      });
      const err = await runAgentToCompletion(env, START, opts(clock)).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 0, code: "network_error", phase: "poll", runId: RUN_ID });
      expect((err as Error).message).toContain("TypeError");
      expect((err as Error).message).not.toContain("secret.example.test");
    });

    it("names the platform's request limit when that is what stopped a start or a poll", async () => {
      const limit = () => {
        throw new Error("Too many subrequests. https://secret.example.test/hook");
      };
      fetchMock.intercept({ method: "POST", url: RUN_ASYNC_API, reply: limit });
      const start = await runAgentToCompletion(env, START, opts(fakeClock())).catch((e: unknown) => e);
      expect(start).toMatchObject({ status: 0, code: "subrequest_limit", phase: "start", runId: null });
      expect((start as Error).message).not.toContain("secret.example.test");

      interceptStart();
      fetchMock.intercept({ method: "GET", url: runUrl(RUN_ID, "none"), reply: limit, times: 4 });
      const poll = await runAgentToCompletion(env, START, opts(fakeClock())).catch((e: unknown) => e);
      expect(poll).toMatchObject({ status: 0, code: "subrequest_limit", phase: "poll", runId: RUN_ID });
      expect((poll as Error).message).not.toContain("secret.example.test");
    });

    it("a poll that works resets the count: five failures in all, never four in a row, still completes", async () => {
      const clock = fakeClock();
      interceptStart();
      pollNone({ status: 503, body: "down" }, 3);
      pollNone({ json: running });
      pollNone({ status: 502, body: "bad gateway" }, 2);
      completed();
      const out = await runAgentToCompletion(env, START, opts(clock));
      expect(out.status).toBe("COMPLETED");
      expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(7);
    });

    it("keeps maxWaitMs a real bound: polls that keep failing past the deadline end as phase timeout, not poll", async () => {
      const clock = fakeClock();
      interceptStart();
      pollNone({ status: 503, body: "down" }, 10);
      const err = await runAgentToCompletion(env, START, opts(clock, { maxWaitMs: 10_000 })).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 504, code: "agent_timeout", phase: "timeout", runId: RUN_ID });
      expect(callsTo("GET", runUrl(RUN_ID, "none"))).toHaveLength(2);
      expect(await spendRows()).toEqual([]);
    });

    it("sends each poll with a request timeout, and the screenshot read too", async () => {
      const clock = fakeClock();
      interceptStart();
      const signals: (AbortSignal | undefined)[] = [];
      fetchMock.intercept({
        method: "GET",
        url: runUrl(RUN_ID, "none"),
        reply: (req) => {
          signals.push(req.signal);
          return Response.json(liDeep);
        },
      });
      fetchMock.intercept({
        method: "GET",
        url: runUrl(RUN_ID, "url"),
        reply: (req) => {
          signals.push(req.signal);
          return Response.json(withScreenshots(liDeep));
        },
      });
      expect(POLL_TIMEOUT_MS).toBe(30_000);
      // A 20 ms timeout, so the test can see the signals fire; the default is 30 s.
      await runAgentToCompletion(env, START, opts(clock, { pollTimeoutMs: 20 }));
      expect(signals).toHaveLength(2);
      for (const signal of signals) expect(signal!.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (const signal of signals) {
        expect(signal!.aborted).toBe(true);
        expect((signal!.reason as Error).name).toBe("TimeoutError");
      }
    });

    it("the worst-case hold of one call is the 429 waits + maxWaitMs + one poll interval + two request timeouts, and fits in the slot's staleness", () => {
      expect(agentHoldBudgetMs({ pollEveryMs: 5_000, maxWaitMs: 200_000 })).toBe(3 * 60_000 + 200_000 + 5_000 + 2 * POLL_TIMEOUT_MS);
      expect(agentHoldBudgetMs({ pollEveryMs: 5_000, maxWaitMs: 200_000 })).toBe(445_000);
      expect(agentHoldBudgetMs({ pollEveryMs: 1_000, maxWaitMs: 10_000, pollTimeoutMs: 2_000 })).toBe(180_000 + 10_000 + 1_000 + 4_000);
      expect(agentHoldBudgetMs({ pollEveryMs: 5_000, maxWaitMs: 200_000 })).toBeLessThan(AGENT_SLOT_STALE_MS);
    });
  });
});

// ---------------------------------------------------------------------------
// browser.ts
// ---------------------------------------------------------------------------

describe("screenshotFullPage", () => {
  const PAGE = "https://atlas.phila.gov/1234%20MARKET%20ST/property";
  const JPEG_B64 = btoa("\xff\xd8full-page\xff\xd9");
  type Sent = { id: number; method: string; params: Record<string, unknown> };

  function fakeBrowser(opts: { settleOnAsk?: number } = {}) {
    const sent: Sent[] = [];
    fetchMock.intercept({
      method: "POST",
      url: BROWSER_API,
      times: Infinity,
      reply: { json: browserCreate },
    });
    fetchMock.intercept({
      method: "GET",
      url: browserCreate.base_url,
      times: Infinity,
      reply: () => {
        const pair = new WebSocketPair();
        const server = pair[1];
        server.accept();
        let asks = 0;
        server.addEventListener("message", (m) => {
          const msg = JSON.parse(String(m.data)) as Sent;
          sent.push(msg);
          const reply = (result: unknown) => server.send(JSON.stringify({ id: msg.id, result }));
          switch (msg.method) {
            case "Target.getTargets":
              return reply({ targetInfos: [{ type: "page", targetId: "t-1" }] });
            case "Target.attachToTarget":
              return reply({ sessionId: "cdp-1" });
            case "Page.getLayoutMetrics":
              return reply({ cssContentSize: { height: 2400 } });
            case "Page.captureScreenshot":
              return reply({ data: JPEG_B64 });
            case "Runtime.evaluate": {
              asks += 1;
              const value = opts.settleOnAsk === undefined ? false : asks >= opts.settleOnAsk - 1;
              return reply({ result: { type: "boolean", value } });
            }
            case "Browser.close":
              reply({});
              server.close(1000, "closed");
              return;
            default:
              return reply({});
          }
        });
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    });
    fetchMock.intercept({
      method: "GET",
      url: /^data:image\/jpeg;base64,/,
      times: Infinity,
      reply: (req) => {
        const b64 = req.url.slice("data:image/jpeg;base64,".length);
        return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      },
    });
    return { sent };
  }

  it("records a screenshot spend row at session creation and throws a clear error when there is no cdp_url", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: { session_id: "tf-1" } } });
    fetchMock.intercept({ method: "DELETE", url: `${BROWSER_API}/tf-1`, reply: { status: 204 } });
    await expect(screenshotFullPage(env, PAGE)).rejects.toThrow(/cdp_url/);
    expect(callsTo("POST", BROWSER_API)[0]!.body).toEqual({ url: PAGE });
    // The session was made and is billed by the minute, so it is ended even though it was never used.
    expect(callsTo("DELETE", `${BROWSER_API}/tf-1`)).toHaveLength(1);
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: PAGE }]);
  });

  it("ends the session when the socket cannot be opened, and keeps the first error when ending it fails too", async () => {
    const end = `${BROWSER_API}/${browserCreate.session_id}`;
    const refuse = () => {
      fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: browserCreate } });
      fetchMock.intercept({ method: "GET", url: browserCreate.base_url, reply: () => new Response("not a websocket", { status: 200 }) });
    };
    refuse();
    fetchMock.intercept({ method: "DELETE", url: end, reply: { status: 204 } });
    await expect(screenshotFullPage(env, PAGE)).rejects.toThrow(/websocket/i);
    expect(callsTo("DELETE", end)).toHaveLength(1);
    refuse();
    fetchMock.intercept({ method: "DELETE", url: end, reply: { status: 500, body: "boom" } });
    await expect(screenshotFullPage(env, PAGE)).rejects.toThrow(/websocket/i);
    expect(callsTo("DELETE", end)).toHaveLength(2);
    // Ending a session is free: only the two sessions are in the ledger.
    expect(await spendRows()).toHaveLength(2);
  });

  it("opens the CDP socket without the API key and throws a clear error when the upgrade is refused", async () => {
    fetchMock.intercept({ method: "POST", url: BROWSER_API, reply: { json: browserCreate } });
    fetchMock.intercept({
      method: "GET",
      url: browserCreate.base_url,
      reply: (req) => {
        expect(req.headers.get("Upgrade")).toBe("websocket");
        expect(req.headers.get("X-API-Key")).toBeNull();
        return new Response("not a websocket", { status: 200 });
      },
    });
    fetchMock.intercept({ method: "DELETE", url: `${BROWSER_API}/${browserCreate.session_id}`, reply: { status: 204 } });
    await expect(screenshotFullPage(env, PAGE)).rejects.toThrow(/websocket/i);
    expect(await spendRows()).toHaveLength(1);
  });

  it("captures as soon as the page has settled on two consecutive asks", async () => {
    expect(MIN_EVIDENCE_BYTES).toBe(12_000);
    const browser = fakeBrowser({ settleOnAsk: 3 });
    const sleeps: number[] = [];
    const result = await screenshotFullPage(env, PAGE, { sleep: async (ms) => { sleeps.push(ms); } });
    const evaluates = browser.sent.filter((m) => m.method === "Runtime.evaluate");
    expect(evaluates).toHaveLength(3);
    expect(String(evaluates[0]!.params.expression)).toContain("readyState");
    expect(String(evaluates[0]!.params.expression)).toContain(JSON.stringify(LOADING_PLACEHOLDER));
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(result.settled).toBe(true);
    expect(browser.sent.filter((m) => m.method === "Page.captureScreenshot")).toHaveLength(1);
    // A session that was used is closed over its own socket; nothing else is called.
    expect(browser.sent.filter((m) => m.method === "Browser.close")).toHaveLength(1);
    expect(fetchMock.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(await spendRows()).toEqual([{ kind: "screenshot", amount_usd: 0.002, ref: PAGE }]);
  });

  it("captures at the 25s deadline when the page never settles", async () => {
    const browser = fakeBrowser();
    const sleeps: number[] = [];
    const result = await screenshotFullPage(env, PAGE, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(browser.sent.filter((m) => m.method === "Runtime.evaluate")).toHaveLength(25);
    expect(sleeps).toEqual(Array.from({ length: 25 }, () => 1_000));
    expect(result.settled).toBe(false);
    expect(browser.sent.filter((m) => m.method === "Page.captureScreenshot")).toHaveLength(1);
  });
});
